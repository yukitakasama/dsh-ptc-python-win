"""Child bootstrap for the dsh-ptc-python-win runtime.

The host spawns this file once per ``run_code`` call and speaks newline-delimited
JSON over a loopback TCP connection:

* child -> host: ``{"t": "boot", "token": ...}``, ``{"t": "call", ...}``,
  ``{"t": "done", ...}``
* host -> child: ``{"t": "run", ...}``, ``{"t": "reply", ...}``

The model program runs inside this process; its ``print`` output is the
process's own stdout/stderr, which the host captures as program logs. The
channel therefore carries control traffic only, so a program that prints
anything (including text shaped like a frame) cannot forge one.
"""

import asyncio
import json
import os
import sys
import traceback

PROGRAM_FILENAME = "<dsh-run-code>"
MAX_LOSSLESS_INT = 2**53 - 1


class InvalidOutput(Exception):
    """Raised when the program produced a value JSON cannot carry losslessly."""


class Connection:
    """One JSON-lines channel to the host."""

    def __init__(self, reader, writer):
        self._reader = reader
        self._writer = writer
        self._lock = asyncio.Lock()
        self._next_id = 0

    def next_id(self):
        self._next_id += 1
        return self._next_id

    async def send(self, frame):
        data = json.dumps(frame, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
        async with self._lock:
            self._writer.write(data.encode("utf-8"))
            await self._writer.drain()

    async def recv(self):
        line = await self._reader.readline()
        if not line:
            return None
        return json.loads(line.decode("utf-8"))

    async def close(self):
        try:
            self._writer.close()
            await self._writer.wait_closed()
        except Exception:
            pass


def _dedent_body(body):
    """Indent a program body so it can sit inside the async wrapper."""
    indented = "".join(
        ("    " + line) if line.strip() else line for line in body.splitlines(keepends=True)
    )
    return indented if indented.strip() else "    pass\n"


def _compile_module(body):
    return compile(body, PROGRAM_FILENAME, "exec")


def _compile_wrapper(body):
    source = "async def __dsh_main__():\n" + _dedent_body(body) + "\n"
    return compile(source, PROGRAM_FILENAME, "exec")


def _describe_syntax_error(error, wrapped):
    message = error.msg if isinstance(error.msg, str) else str(error)
    line = error.lineno
    text = error.text
    if wrapped and isinstance(line, int):
        line = max(1, line - 1)
        if isinstance(text, str) and text.startswith("    "):
            text = text[4:]
    parts = ["SyntaxError: " + message]
    if isinstance(line, int):
        parts.append('  File "%s", line %d' % (error.filename or PROGRAM_FILENAME, line))
    if isinstance(text, str) and text.strip():
        parts.append("    " + text.strip())
    return "\n".join(parts)


def _describe_exception(error, wrapped):
    if isinstance(error, SyntaxError):
        return _describe_syntax_error(error, wrapped)
    if isinstance(error, InvalidOutput):
        return "InvalidOutput: " + str(error)
    lines = ["Traceback (most recent call last):"]
    try:
        frames = traceback.extract_tb(error.__traceback__)
    except Exception:
        frames = []
    for frame in frames:
        if frame.filename == __file__:
            continue
        lines.append('  File "%s", line %d, in %s' % (frame.filename, frame.lineno, frame.name))
        source = frame.line
        if isinstance(source, str) and source.strip():
            lines.append("    " + source.strip())
    lines.extend(traceback.format_exception_only(type(error), error))
    return "\n".join(lines).rstrip()


def _lossless(value, path="$"):
    """Normalize one Python value into JSON, rejecting anything JSON cannot carry."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if value > MAX_LOSSLESS_INT or value < -MAX_LOSSLESS_INT:
            raise InvalidOutput(
                "%s: integer %d does not survive JSON losslessly (|n| must be <= 2^53 - 1)" % (path, value)
            )
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise InvalidOutput("%s: non-finite float %r is not JSON" % (path, value))
        return value
    if isinstance(value, (list, tuple)):
        return [_lossless(item, "%s[%d]" % (path, index)) for index, item in enumerate(value)]
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise InvalidOutput("%s: object key %r is not a string" % (path, key))
            out[key] = _lossless(item, "%s.%s" % (path, key))
        return out
    if asyncio.iscoroutine(value):
        raise InvalidOutput(
            "%s: the program returned a coroutine; await it (for example `return await ...`) before returning"
            % path
        )
    raise InvalidOutput(
        "%s: %s is not JSON-serializable; return str, int, float, bool, None, list, or dict"
        % (path, type(value).__name__)
    )


class BindingNamespace:
    """Attribute namespace exposing one host binding namespace (for example ``tools``)."""

    def __init__(self, global_name, functions, invoke):
        object.__setattr__(self, "_global", global_name)
        object.__setattr__(self, "_functions", tuple(functions))
        object.__setattr__(self, "_invoke", invoke)

    def __dir__(self):
        return list(object.__getattribute__(self, "_functions"))

    def __getattr__(self, name):
        functions = object.__getattribute__(self, "_functions")
        if name not in functions:
            raise AttributeError(
                "no tool named %r is bound in this program (available: %s)"
                % (name, ", ".join(functions) or "(none)")
            )
        global_name = object.__getattribute__(self, "_global")
        invoke = object.__getattribute__(self, "_invoke")

        async def call(args=None, **kwargs):
            payload = {}
            if args is not None:
                if not isinstance(args, dict):
                    raise TypeError(
                        "%s.%s expects a dict of arguments, got %s"
                        % (global_name, name, type(args).__name__)
                    )
                payload.update(args)
            if kwargs:
                payload.update(kwargs)
            try:
                _lossless(payload)
            except InvalidOutput as error:
                raise TypeError("tool arguments must be lossless JSON: %s" % error) from None
            return await invoke(global_name, name, payload)

        call.__name__ = name
        return call

    def __repr__(self):
        return "<binding %s: %s>" % (
            object.__getattribute__(self, "_global"),
            ", ".join(object.__getattribute__(self, "_functions")) or "(empty)",
        )


async def _pump(connection, pending):
    """Deliver host replies to the coroutines awaiting them."""
    try:
        while True:
            frame = await connection.recv()
            if frame is None:
                return
            if isinstance(frame, dict) and frame.get("t") == "reply":
                future = pending.pop(frame.get("id"), None)
                if future is not None and not future.done():
                    future.set_result(frame)
    except asyncio.CancelledError:
        raise
    except Exception:
        return


def _make_invoke(connection, pending, error_classes):
    async def invoke(namespace, function, args):
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        call_id = connection.next_id()
        pending[call_id] = future
        await connection.send(
            {"t": "call", "id": call_id, "ns": namespace, "fn": function, "args": args}
        )
        frame = await future
        if frame.get("ok"):
            return frame.get("value")
        detail = frame.get("error") or {}
        message = detail.get("message") or ("%s failed" % function)
        error_class = error_classes.get(namespace)
        if error_class is not None:
            error = error_class(message)
            try:
                setattr(error, error_class.__dsh_member__, function)
            except Exception:
                pass
            raise error
        raise RuntimeError(message)

    return invoke


async def _execute(body, environment):
    """Run the program, wrapping it in an async function only when it needs one."""
    module_error = None
    try:
        code = _compile_module(body)
    except SyntaxError as error:
        module_error = error
    else:
        exec(code, environment)
        return None

    try:
        wrapped = _compile_wrapper(body)
    except SyntaxError:
        raise module_error from None

    exec(wrapped, environment)
    return await environment["__dsh_main__"]()


async def _serve(connection, run):
    cwd = run.get("cwd")
    if isinstance(cwd, str) and cwd:
        try:
            os.chdir(cwd)
        except OSError as error:
            return {
                "t": "done",
                "error": {"kind": "exception", "message": "cannot enter working directory %r: %s" % (cwd, error)},
            }

    pending = {}
    error_classes = {}
    environment = {"__name__": "__dsh_program__"}
    invoke = _make_invoke(connection, pending, error_classes)

    for binding in run.get("bindings") or []:
        if not isinstance(binding, dict):
            continue
        global_name = binding.get("global")
        if not isinstance(global_name, str) or not global_name:
            continue
        error_class = binding.get("errorClass")
        if isinstance(error_class, dict):
            name = error_class.get("name")
            member = error_class.get("memberNameProperty")
            if isinstance(name, str) and isinstance(member, str):
                cls = type(name, (Exception,), {"__dsh_member__": member})
                environment[name] = cls
                error_classes[global_name] = cls
        environment[global_name] = BindingNamespace(global_name, binding.get("functions") or (), invoke)

    pump = asyncio.create_task(_pump(connection, pending))
    wrapped = False
    try:
        try:
            _compile_module(run.get("program") or "")
        except SyntaxError:
            wrapped = True
        value = await _execute(run.get("program") or "", environment)
        checked = _lossless(value)
        encoded = json.dumps(checked, ensure_ascii=False, allow_nan=False)
        limit = run.get("maxValueBytes")
        if isinstance(limit, int) and limit > 0 and len(encoded.encode("utf-8")) > limit:
            return {
                "t": "done",
                "error": {
                    "kind": "output-limit",
                    "message": "the returned value is %d bytes; the cap is %d bytes"
                    % (len(encoded.encode("utf-8")), limit),
                },
            }
        return {"t": "done", "value": checked}
    except BaseException as error:  # noqa: BLE001 - every program failure is a result field
        kind = "invalid-output" if isinstance(error, InvalidOutput) else "exception"
        return {
            "t": "done",
            "error": {"kind": kind, "message": _describe_exception(error, wrapped)},
        }
    finally:
        pump.cancel()


async def _main(argv):
    if len(argv) != 2:
        print("usage: bootstrap.py <token> <port>", file=sys.stderr)
        return 2
    token, port = argv[0], int(argv[1])
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
    except OSError as error:
        print("cannot connect to the host control channel: %s" % error, file=sys.stderr)
        return 3
    connection = Connection(reader, writer)
    try:
        await connection.send({"t": "boot", "token": token})
        run = await connection.recv()
        if not isinstance(run, dict) or run.get("t") != "run":
            return 4
        await connection.send(await _serve(connection, run))
        return 0
    finally:
        await connection.close()


def main():
    # UTF-8 on both streams keeps non-ASCII output intact regardless of code page;
    # the host also sets PYTHONUTF8/PYTHONIOENCODING for subprocesses.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    sys.exit(asyncio.run(_main(sys.argv[1:])))


if __name__ == "__main__":
    main()
