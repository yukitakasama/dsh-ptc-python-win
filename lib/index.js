/**
 * CPython PTC runtime provider for DeepSeek Harness on Windows.
 *
 * Registers one `ctx.ptcRuntime` implementation whose language is `python`. Each
 * model program runs in a fresh `python` process; the program is the body of an
 * async Python function, so top-level `await` and `return` both work. Tool calls
 * travel over a loopback TCP channel as JSON lines, leaving stdout/stderr free
 * for the program's own output. Direct file effects are NOT confined: this
 * provider reports `sandboxMode === undefined`, so the executor passes no file
 * policy and exposes no `sandbox_permissions` argument.
 *
 * The package deliberately imports no `@deepseek-ai/*` module: it is mounted from
 * a profile whose node_modules layout is managed by the harness, and a provider
 * that duck-types the documented seam keeps that layout irrelevant. The service
 * is registered through the same reflection API that `Service` uses internally.
 *
 * @module dsh-ptc-python-win
 */
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'ptc-runtime-python-win'

const BOOTSTRAP_PATH = fileURLToPath(new URL('../py/bootstrap.py', import.meta.url))
const SERVICE_NAME = 'ptcRuntime'
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const KILL_GRACE_MS = 2000
const CONNECT_TIMEOUT_MS = 20000
const VERSION_PROBE_MS = 15000

const DEFAULTS = {
	pythonBin: process.platform === 'win32' ? 'python' : 'python3',
	defaultTimeoutMs: 120000,
	maxTimeoutMs: 600000,
	maxLogBytes: 65536,
	maxValueBytes: 32768,
	maxCallValueBytes: 4 * 1024 * 1024,
}

/** Names this provider refuses as binding globals, mirroring the shared seam contract. */
const RESERVED_BINDING_GLOBALS = new Set(['console', '__dsh_main__', '__builtins__', '__name__', '__debug__'])
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const DUNDER_MEMBER = /^__.+__$/
const RESERVED_ERROR_MEMBERS = new Set(['name', 'message', 'stack', 'args', 'with_traceback', 'add_note'])

/** Failure kinds the child may report on its `done` frame. */
const PROGRAM_ERROR_KINDS = new Set(['exception', 'invalid-output', 'output-limit'])

/**
 * Normalize and validate plugin config.
 * @param config - Raw cordis config object (every field optional).
 * @returns a fully populated config.
 */
export function normalizeConfig(config = {}) {
	const pythonBin = config.pythonBin === undefined ? DEFAULTS.pythonBin : config.pythonBin
	if (typeof pythonBin !== 'string' || pythonBin.length === 0) throw new Error('ptc-python: pythonBin must be a non-empty string')
	const positive = (value, fallback, label) => {
		if (value === undefined) return fallback
		if (!Number.isInteger(value) || value <= 0) throw new Error(`ptc-python: ${label} must be a positive integer`)
		return value
	}
	const defaultTimeoutMs = positive(config.defaultTimeoutMs, DEFAULTS.defaultTimeoutMs, 'defaultTimeoutMs')
	const maxTimeoutMs = positive(config.maxTimeoutMs, DEFAULTS.maxTimeoutMs, 'maxTimeoutMs')
	if (maxTimeoutMs < defaultTimeoutMs) throw new Error('ptc-python: maxTimeoutMs must not be below defaultTimeoutMs')
	return {
		pythonBin,
		defaultTimeoutMs,
		maxTimeoutMs,
		maxLogBytes: positive(config.maxLogBytes, DEFAULTS.maxLogBytes, 'maxLogBytes'),
		maxValueBytes: positive(config.maxValueBytes, DEFAULTS.maxValueBytes, 'maxValueBytes'),
		maxCallValueBytes: positive(config.maxCallValueBytes, DEFAULTS.maxCallValueBytes, 'maxCallValueBytes'),
	}
}

/**
 * Read the interpreter version once per resolved binary.
 * @param bin - configured interpreter command or path.
 * @returns the reported version triple.
 */
function probePython(bin) {
	return new Promise((resolve, reject) => {
		const probe = spawn(bin, ['-I', '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		})
		let out = ''
		let err = ''
		const timer = setTimeout(() => {
			killTree(probe)
			reject(new Error(`ptc-python: pythonBin ${JSON.stringify(bin)} did not answer a version probe within ${VERSION_PROBE_MS} ms`))
		}, VERSION_PROBE_MS)
		probe.stdout.setEncoding('utf8')
		probe.stderr.setEncoding('utf8')
		probe.stdout.on('data', (chunk) => { out += chunk })
		probe.stderr.on('data', (chunk) => { err += chunk })
		probe.on('error', (error) => {
			clearTimeout(timer)
			reject(new Error(`ptc-python: cannot start pythonBin ${JSON.stringify(bin)}: ${error.message}`))
		})
		probe.on('close', (code) => {
			clearTimeout(timer)
			if (code !== 0) {
				reject(new Error(`ptc-python: pythonBin ${JSON.stringify(bin)} exited with code ${code}: ${err.trim() || '(no stderr)'}`))
				return
			}
			const match = /^(\d+)\.(\d+)\.(\d+)$/m.exec(out.trim())
			if (match === null) {
				reject(new Error(`ptc-python: pythonBin ${JSON.stringify(bin)} did not print a version triple`))
				return
			}
			const [major, minor, patch] = match.slice(1).map(Number)
			if (major !== 3 || minor < 10) {
				reject(new Error(`ptc-python: pythonBin ${JSON.stringify(bin)} is CPython ${major}.${minor}.${patch}; >= 3.10 is required`))
				return
			}
			resolve({ text: `${major}.${minor}.${patch}` })
		})
	})
}

/**
 * Terminate one child and everything it left in its process tree.
 * Windows has no process groups reachable through Node signals, so `taskkill /T`
 * is what reaches grandchildren; `kill` is the fallback when taskkill is absent.
 * @param child - the spawned interpreter.
 */
function killTree(child) {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
	if (process.platform === 'win32') {
		const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
		killer.on('error', () => {})
	}
	try {
		child.kill('SIGKILL')
	} catch {}
}

/**
 * Resolve when a child settles, or after a grace period.
 * @param child - the spawned interpreter.
 * @param graceMs - maximum wait in milliseconds.
 */
function waitForExit(child, graceMs) {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve()
			return
		}
		const timer = setTimeout(resolve, graceMs)
		child.once('close', () => {
			clearTimeout(timer)
			resolve()
		})
	})
}

/**
 * The environment the interpreter receives. Windows needs SYSTEMROOT for the
 * CRT and Python's stdlib; UTF-8 mode keeps `print` of non-ASCII text intact and
 * independent of the console code page.
 * @returns a scrubbed environment.
 */
function childEnvironment() {
	const keep = [
		'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
		'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
		'PATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
	]
	const env = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }
	for (const key of keep) {
		const value = process.env[key]
		if (value !== undefined) env[key] = value
	}
	return env
}

/**
 * Validate one binding namespace against the shared portable contract.
 * @param binding - namespace supplied by the executor.
 * @param index - position, for error text.
 */
function validateBinding(binding, index) {
	if (binding === null || typeof binding !== 'object') throw new Error(`ptc-python: binding ${index} must be an object`)
	const global = binding.global
	if (typeof global !== 'string' || !IDENTIFIER.test(global)) {
		throw new Error(`ptc-python: binding ${index} global ${JSON.stringify(global)} is not a portable identifier`)
	}
	if (RESERVED_BINDING_GLOBALS.has(global)) throw new Error(`ptc-python: binding global ${JSON.stringify(global)} is reserved`)
	if (binding.functions === null || typeof binding.functions !== 'object') throw new Error(`ptc-python: binding ${index} functions must be an object`)
	const errorClass = binding.errorClass
	if (errorClass !== undefined) {
		if (typeof errorClass.name !== 'string' || !IDENTIFIER.test(errorClass.name)) {
			throw new Error(`ptc-python: binding ${index} errorClass.name must be a portable identifier`)
		}
		if (RESERVED_BINDING_GLOBALS.has(errorClass.name)) throw new Error(`ptc-python: binding ${index} errorClass.name is reserved`)
		if (typeof errorClass.memberNameProperty !== 'string' || !IDENTIFIER.test(errorClass.memberNameProperty)) {
			throw new Error(`ptc-python: binding ${index} errorClass.memberNameProperty must be a portable identifier`)
		}
		if (RESERVED_ERROR_MEMBERS.has(errorClass.memberNameProperty) || DUNDER_MEMBER.test(errorClass.memberNameProperty)) {
			throw new Error(`ptc-python: binding ${index} errorClass.memberNameProperty is reserved`)
		}
	}
}

/**
 * Build one runtime instance. Exported so the provider is testable without a
 * cordis context.
 * @param rawConfig - plugin config.
 * @returns the runtime value registered as `ctx.ptcRuntime`.
 */
export function createPythonRuntime(rawConfig = {}) {
	const config = normalizeConfig(rawConfig)
	let probe = null
	const live = new Set()
	let disposed = false

	const ensureInterpreter = () => {
		probe ??= probePython(config.pythonBin).catch((error) => {
			probe = null
			throw error
		})
		return probe
	}

	const runtime = {
		language: 'python',
		isolation: 'process',
		// The executor renders its generic program guidance for every format other
		// than `function-body`; reporting `function-body` would describe the language
		// as TypeScript. `script` is the honest description of a top-level program.
		programFormat: 'script',
		retainsState: false,
		release() {
			return Promise.resolve()
		},
		sandboxMode: undefined,
		timeout: { defaultMs: config.defaultTimeoutMs, maxMs: config.maxTimeoutMs },
		executionInstructions:
			'The program is a Python 3.10+ program (top-level `await` and `return` are accepted; a plain script also works). ' +
			'Call tools as `await tools.name(args)` — every call returns the tool\'s canonical JSON value, and a failed call raises `ToolCallError` whose `toolName` names the tool. ' +
			'Emit output with `print(...)` and/or `return` a lossless JSON value; only printed text and the returned value reach the conversation. ' +
			'Each call runs in a fresh process: variables, imports, and modules do not persist across calls. ' +
			'Relative paths resolve against the working directory. Direct filesystem access is NOT confined by the DSH sandbox.',

		resolve(request) {
			if (disposed) throw new Error('ptc-python: runtime is disposed')
			const cwd = request.cwd ?? process.cwd()
			if (!path.isAbsolute(cwd)) throw new Error(`ptc-python: cwd must be absolute, got ${JSON.stringify(cwd)}`)
			let timeoutMs = config.defaultTimeoutMs
			if (request.timeoutMs !== undefined && request.timeoutMs !== null) {
				if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
					throw new Error('ptc-python: timeoutMs must be a positive integer')
				}
				if (request.timeoutMs > config.maxTimeoutMs) {
					throw new Error(`ptc-python: timeoutMs ${request.timeoutMs} exceeds the ${config.maxTimeoutMs} ms cap`)
				}
				timeoutMs = request.timeoutMs
			}
			const bindings = request.bindings ?? []
			if (!Array.isArray(bindings)) throw new Error('ptc-python: bindings must be an array')
			bindings.forEach(validateBinding)
			return { ...request, bindings, cwd, timeoutMs }
		},

		async run(spec) {
			if (disposed) return { logs: [], error: { kind: 'abort', message: 'ptc-python: runtime is disposed' } }
			try {
				await ensureInterpreter()
			} catch (error) {
				return { logs: [], error: { kind: 'worker-exit', message: String(error?.message ?? error) } }
			}
			return runProgram({ spec, config, live })
		},

		async dispose() {
			disposed = true
			const running = [...live]
			for (const kill of running) kill()
			// Each killed run settles through its own close handler; give those
			// handlers a turn before the fiber goes away for good.
			await new Promise((done) => setTimeout(done, Math.min(KILL_GRACE_MS, 1000)))
		},
	}

	return runtime
}

/**
 * Spawn, talk to, and tear down one program run.
 * @param options - resolved spec, validated config, and the live-run kill registry.
 * @returns the run result; never rejects for program-level failures.
 */
function runProgram({ spec, config, live }) {
	return new Promise((resolve) => {
		const logs = []
		let logBytes = 0
		let logTruncated = false
		const appendLog = (text) => {
			if (logTruncated) return
			const size = Buffer.byteLength(text)
			if (logBytes + size > config.maxLogBytes) {
				const room = config.maxLogBytes - logBytes
				if (room > 0) logs.push(`${text.slice(0, room)}\n`)
				logs.push(`[log truncated after ${config.maxLogBytes} bytes]`)
				logBytes = config.maxLogBytes
				logTruncated = true
				return
			}
			logBytes += size
			logs.push(text)
		}

		const server = net.createServer()
		let socket
		let child
		let buffer = ''
		let finished = false
		let timedOut = false
		let aborted = false
		let connectTimer
		let wallTimer
		let booted = false

		const token = randomBytes(24).toString('hex')
		const expected = Buffer.from(token)

		const settle = async (result) => {
			if (finished) return
			finished = true
			clearTimeout(connectTimer)
			clearTimeout(wallTimer)
			spec.signal?.removeEventListener?.('abort', onAbort)
			live.delete(kill)
			try {
				socket?.destroy()
			} catch {}
			try {
				server.close()
			} catch {}
			if (child !== undefined) {
				if (child.exitCode === null && child.signalCode === null) killTree(child)
				await waitForExit(child, KILL_GRACE_MS)
			}
			const text = logs.join('')
			const lines = text.length === 0 ? [] : text.split(/\r?\n/)
			if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
			resolve({
				...(result.value === undefined ? {} : { value: result.value }),
				...(result.error === undefined ? {} : { error: result.error }),
				logs: lines,
			})
		}

		const kill = () => {
			if (child !== undefined) killTree(child)
		}

		const onAbort = () => {
			aborted = true
			kill()
			void settle({ error: { kind: 'abort', message: 'ptc-python: program aborted by the caller' } })
		}

		const reply = (frame) => {
			if (socket === undefined || socket.destroyed) return
			try {
				socket.write(`${JSON.stringify(frame)}\n`)
			} catch {}
		}

		const handleCall = async (frame) => {
			const id = frame.id
			const namespace = namespaces.get(frame.ns)
			if (namespace === undefined) {
				reply({ t: 'reply', id, ok: false, error: { name: 'NameError', message: `no binding namespace named ${JSON.stringify(frame.ns)}` } })
				return
			}
			const fn = namespace.functions?.[frame.fn]
			if (typeof fn !== 'function') {
				reply({ t: 'reply', id, ok: false, error: { name: 'NameError', message: `no tool named ${JSON.stringify(frame.fn)} is bound in namespace ${JSON.stringify(frame.ns)}` } })
				return
			}
			try {
				const value = await fn(frame.args ?? {})
				const encoded = value === undefined ? 'null' : JSON.stringify(value)
				if (encoded === undefined) {
					reply({ t: 'reply', id, ok: true, value: null })
					return
				}
				if (Buffer.byteLength(encoded) > config.maxCallValueBytes) {
					reply({ t: 'reply', id, ok: false, error: { name: 'OutputLimitError', message: `tool ${JSON.stringify(frame.fn)} returned ${Buffer.byteLength(encoded)} bytes, above the ${config.maxCallValueBytes} byte cap` } })
					return
				}
				reply({ t: 'reply', id, ok: true, value: JSON.parse(encoded) })
			} catch (error) {
				reply({ t: 'reply', id, ok: false, error: { name: String(error?.name ?? 'Error'), message: String(error?.message ?? error) } })
			}
		}

		const handleLine = (line) => {
			let frame
			try {
				frame = JSON.parse(line)
			} catch {
				void settle({ error: { kind: 'protocol', message: 'ptc-python: malformed frame from the Python bootstrap' } })
				return
			}
			if (frame === null || typeof frame !== 'object') {
				void settle({ error: { kind: 'protocol', message: 'ptc-python: frame is not an object' } })
				return
			}
			switch (frame.t) {
				case 'boot': {
					const offered = Buffer.from(String(frame.token ?? ''))
					const valid = offered.length === expected.length && timingSafeEqual(offered, expected)
					if (!valid) {
						killTree(child)
						void settle({ error: { kind: 'protocol', message: 'ptc-python: bootstrap presented a wrong boot token' } })
						return
					}
					booted = true
					clearTimeout(connectTimer)
					const bindings = spec.bindings.map((binding) => ({
						global: binding.global,
						functions: Object.keys(binding.functions ?? {}),
						...(binding.errorClass === undefined ? {} : { errorClass: binding.errorClass }),
					}))
					reply({ t: 'run', program: spec.program, cwd: spec.cwd, bindings, maxValueBytes: config.maxValueBytes })
					armWallClock()
					return
				}
				case 'call':
					void handleCall(frame)
					return
				case 'done': {
					if (frame.error !== undefined) {
						const kind = PROGRAM_ERROR_KINDS.has(frame.error.kind) ? frame.error.kind : 'exception'
						void settle({ error: { kind, message: String(frame.error.message ?? 'program failed') } })
						return
					}
					const value = frame.value === undefined ? undefined : frame.value
					if (value !== undefined) {
						const encoded = JSON.stringify(value)
						if (encoded !== undefined && Buffer.byteLength(encoded) > config.maxValueBytes) {
							void settle({ error: { kind: 'output-limit', message: `ptc-python: returned value is ${Buffer.byteLength(encoded)} bytes, above the ${config.maxValueBytes} byte cap` } })
							return
						}
					}
					void settle({ value })
					return
				}
				default:
					void settle({ error: { kind: 'protocol', message: `ptc-python: unknown frame type ${JSON.stringify(frame.t)}` } })
			}
		}

		const namespaces = new Map(spec.bindings.map((binding) => [binding.global, binding]))

		server.on('connection', (connection) => {
			if (socket !== undefined) {
				connection.destroy()
				return
			}
			socket = connection
			socket.setEncoding('utf8')
			socket.on('data', (chunk) => {
				buffer += chunk
				let index
				while ((index = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, index)
					buffer = buffer.slice(index + 1)
					if (line.trim().length > 0) handleLine(line)
					if (finished) return
				}
				if (buffer.length > MAX_FRAME_BYTES) {
					killTree(child)
					void settle({ error: { kind: 'protocol', message: 'ptc-python: bootstrap frame exceeded the size cap' } })
				}
			})
			socket.on('error', () => {})
		})

		server.on('error', (error) => {
			void settle({ error: { kind: 'worker-exit', message: `ptc-python: control channel failed: ${error.message}` } })
		})

		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address !== null ? address.port : 0
			child = spawn(config.pythonBin, ['-I', '-u', BOOTSTRAP_PATH, token, String(port)], {
				cwd: spec.cwd,
				env: childEnvironment(),
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			})
			child.stdout?.setEncoding('utf8')
			child.stderr?.setEncoding('utf8')
			child.stdout?.on('data', appendLog)
			child.stderr?.on('data', appendLog)
			child.on('error', (error) => {
				void settle({ error: { kind: 'worker-exit', message: `ptc-python: cannot start ${JSON.stringify(config.pythonBin)}: ${error.message}` } })
			})
			child.on('close', (code, signal) => {
				if (finished) return
				if (timedOut) {
					void settle({ error: { kind: 'timeout', message: `ptc-python: program exceeded ${spec.timeoutMs} ms` } })
					return
				}
				if (aborted) {
					void settle({ error: { kind: 'abort', message: 'ptc-python: program aborted by the caller' } })
					return
				}
				const tail = logs.join('').trim()
				void settle({
					error: {
						kind: 'worker-exit',
						message: `ptc-python: the Python process exited (${signal ?? `code ${code}`}) before reporting a result${tail.length === 0 ? '' : `:\n${tail.slice(-2000)}`}`,
					},
				})
			})
			connectTimer = setTimeout(() => {
				if (!booted && !finished) {
					killTree(child)
					void settle({ error: { kind: 'worker-exit', message: `ptc-python: the Python bootstrap did not connect within ${CONNECT_TIMEOUT_MS} ms` } })
				}
			}, CONNECT_TIMEOUT_MS)
		})

		// The wall clock starts when the program is handed over, not while Python boots.
		const armWallClock = () => {
			wallTimer = setTimeout(() => {
				if (finished) return
				timedOut = true
				killTree(child)
			}, spec.timeoutMs)
		}

		if (spec.signal !== undefined && spec.signal !== null) {
			if (spec.signal.aborted) onAbort()
			else spec.signal.addEventListener('abort', onAbort, { once: true })
		}

		live.add(kill)
	})
}

/**
 * Mount the provider as `ctx.ptcRuntime`.
 * @param ctx - the fiber context that owns the service.
 * @param config - plugin config.
 */
export function apply(ctx, config) {
	if (config?.clientAnchor === true) {
		// App-level discovery anchor for the browser bundle. The preset row mounts
		// the real provider inside its isolated realm, so this mount registers
		// nothing: registering `ptcRuntime` here would collide with the host-plane
		// TypeScript runtime.
		return
	}
	const settings = normalizeConfig(config)
	const runtime = createPythonRuntime(settings)
	ctx.reflect.provide(SERVICE_NAME, runtime)
	ctx.effect(() => () => runtime.dispose(), 'ptc-python runtime')
	ctx.logger.info(
		`ptc-python: registered the python PTC runtime (pythonBin=${settings.pythonBin}, ` +
			`defaultTimeoutMs=${settings.defaultTimeoutMs}, maxTimeoutMs=${settings.maxTimeoutMs})`,
	)
	// Opt-in mount trace: the Harness buffers plugin logs behind its own level
	// filter, so a boot-time marker file is the only reliable way to confirm from
	// outside that this preset mounted and registered its service.
	const traceFile = process.env.DSH_PTC_PY_DEBUG
	if (traceFile) {
		try {
			appendFileSync(
				traceFile,
				`${new Date().toISOString()} ptc-python mounted pythonBin=${settings.pythonBin} pid=${process.pid}\n`,
			)
		} catch {
			// A debug trace must never break plugin activation.
		}
	}
}
