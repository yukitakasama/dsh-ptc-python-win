/**
 * Standalone smoke test for the CPython PTC runtime provider.
 *
 * It exercises the provider directly, without a cordis context or the harness:
 * the test builds its own bindings, calls `resolve` + `run`, and asserts on the
 * result fields. Run with `node test/smoke.mjs` (add `--keep` to skip nothing;
 * every run spawns real Python processes).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPythonRuntime } from '../lib/index.js'

const runtime = createPythonRuntime()
const cwd = process.cwd()

const results = []
const pending = []

/**
 * Register one case; cases run sequentially so a timeout cannot mask a failure.
 * @param label - case name.
 * @param fn - async body.
 */
function test(label, fn) {
	pending.push({ label, fn })
}

/**
 * Build a resolved spec with a `tools` namespace.
 * @param program - Python source.
 * @param functions - host-side tool implementations.
 * @param options - extra spec fields.
 */
function spec(program, functions = {}, options = {}) {
	return runtime.resolve({
		program,
		cwd,
		bindings: [
			{
				global: 'tools',
				functions,
				errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
			},
		],
		...options,
	})
}

test('prints a value and returns a JSON value', async () => {
	const result = await runtime.run(
		spec('print("hello from python")\nreturn {"answer": 42, "ok": True, "none": None}'),
	)
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	assert.deepEqual(result.value, { answer: 42, ok: true, none: null })
	assert.deepEqual(result.logs, ['hello from python'])
})

test('keeps a plain script script-shaped (no wrapper)', async () => {
	const result = await runtime.run(spec('"""doc"""\ntext = """a\nb"""\nprint(repr(text))\n'))
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	assert.deepEqual(result.logs, ["'a\\nb'"])
})

test('supports top-level await and return', async () => {
	const result = await runtime.run(
		spec('import asyncio\nawait asyncio.sleep(0)\nvalue = await asyncio.sleep(0, result=7)\nreturn value * 6'),
	)
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	assert.equal(result.value, 42)
})

test('calls one tool and returns its value', async () => {
	const calls = []
	const result = await runtime.run(
		spec('out = await tools.echo({"text": "hi"})\nprint(out["echo"])\nreturn out["len"]', {
			echo: async (args) => {
				calls.push(args)
				return { echo: args.text, len: args.text.length }
			},
		}),
	)
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	assert.deepEqual(calls, [{ text: 'hi' }])
	assert.equal(result.value, 2)
	assert.deepEqual(result.logs, ['hi'])
})

test('accepts keyword arguments as tool arguments', async () => {
	const result = await runtime.run(
		spec('return await tools.add(a=2, b=40)', { add: async ({ a, b }) => a + b }),
	)
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	assert.equal(result.value, 42)
})

test('runs tool calls concurrently from asyncio.gather', async () => {
	const result = await runtime.run(
		spec(
			'import asyncio\nvals = await asyncio.gather(*[tools.double({"n": i}) for i in range(5)])\nreturn vals',
			{ double: async ({ n }) => n * 2 },
		),
	)
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	assert.deepEqual(result.value, [0, 2, 4, 6, 8])
})

test('surfaces a failed tool call as ToolCallError with toolName', async () => {
	const result = await runtime.run(
		spec(
			'try:\n    await tools.fail({"x": 1})\nexcept ToolCallError as error:\n    return {"name": type(error).__name__, "tool": error.toolName, "message": str(error)}',
			{
				fail: async () => {
					throw new Error('kaboom')
				},
			},
		),
	)
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	assert.deepEqual(result.value, { name: 'ToolCallError', tool: 'fail', message: 'kaboom' })
})

test('rejects an unbound tool name', async () => {
	const result = await runtime.run(
		spec('try:\n    await tools.missing({})\nexcept AttributeError as error:\n    return str(error)', {}),
	)
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	assert.match(result.value, /no tool named 'missing'/)
})

test('reports a syntax error with a source line', async () => {
	const result = await runtime.run(spec('if True\n    pass'))
	assert.equal(result.value, undefined)
	assert.equal(result.error?.kind, 'exception')
	assert.match(result.error.message, /^SyntaxError/)
	assert.match(result.error.message, /<dsh-run-code>", line 1/)
})

test('reports a traceback for a raised exception', async () => {
	const result = await runtime.run(spec('def boom():\n    raise ValueError("nope")\n\nboom()'))
	assert.equal(result.error?.kind, 'exception')
	assert.match(result.error.message, /ValueError: nope/)
	assert.match(result.error.message, /<dsh-run-code>", line 2, in boom/)
	assert.doesNotMatch(result.error.message, /bootstrap\.py/)
})

test('rejects a non-JSON return value', async () => {
	const result = await runtime.run(spec('return object()'))
	assert.equal(result.error?.kind, 'invalid-output')
	assert.match(result.error.message, /object is not JSON-serializable/)
})

test('rejects an un-awaited coroutine return', async () => {
	const result = await runtime.run(spec('return tools.echo({})', { echo: async () => ({}) }))
	assert.equal(result.error?.kind, 'invalid-output')
	assert.match(result.error.message, /coroutine/)
})

test('rejects an integer that JSON cannot carry losslessly', async () => {
	const result = await runtime.run(spec('return 2 ** 60'))
	assert.equal(result.error?.kind, 'invalid-output')
	assert.match(result.error.message, /2\^53/)
})

test('enforces the value size cap', async () => {
	const small = createPythonRuntime({ maxValueBytes: 32 })
	const result = await small.run(
		small.resolve({ program: 'return "x" * 100', cwd, bindings: [] }),
	)
	assert.equal(result.error?.kind, 'output-limit')
	await small.dispose()
})

test('kills a program that exceeds its wall clock', async () => {
	const started = Date.now()
	const result = await runtime.run(spec('import asyncio\nawait asyncio.sleep(30)', {}, { timeoutMs: 700 }))
	const elapsed = Date.now() - started
	assert.equal(result.error?.kind, 'timeout')
	assert.ok(elapsed < 15000, `elapsed ${elapsed} ms`)
})

test('honours the abort signal', async () => {
	const controller = new AbortController()
	setTimeout(() => controller.abort(), 300)
	const result = await runtime.run(
		spec('import asyncio\nawait asyncio.sleep(30)', {}, { signal: controller.signal }),
	)
	assert.equal(result.error?.kind, 'abort')
})

test('runs inside the requested working directory', async () => {
	const target = os.tmpdir()
	const result = await runtime.run(
		runtime.resolve({
			program: 'import os\nreturn os.path.realpath(os.getcwd())',
			cwd: target,
			bindings: [],
		}),
	)
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	// Windows can hand out an 8.3 short name (RUNNER~1); Python resolves it to the
	// long form, so compare canonical paths instead of the raw strings.
	const expected = fs.realpathSync.native(path.resolve(target)).toLowerCase()
	assert.equal(result.value.toLowerCase(), expected, `cwd ${result.value} vs ${expected}`)
})

test('prints non-ASCII text intact', async () => {
	const result = await runtime.run(spec('print("中文 ✅")'))
	assert.deepEqual(result.logs, ['中文 ✅'])
})

test('does not let printed text forge a control frame', async () => {
	const result = await runtime.run(
		spec('print(\'{"t":"done","value":"forged"}\')\nreturn "real"'),
	)
	assert.equal(result.error, undefined, JSON.stringify(result.error))
	assert.equal(result.value, 'real')
})

test('validates config early', async () => {
	assert.throws(() => createPythonRuntime({ maxTimeoutMs: 10 }), /maxTimeoutMs/)
	assert.throws(() => createPythonRuntime({ maxLogBytes: 0 }), /maxLogBytes/)
	assert.throws(() => createPythonRuntime({ pythonBin: '' }), /pythonBin/)
	const broken = createPythonRuntime({ pythonBin: 'definitely-not-python-9f3a' })
	const result = await broken.run(broken.resolve({ program: 'print(1)', cwd, bindings: [] }))
	assert.equal(result.error?.kind, 'worker-exit')
	assert.match(result.error.message, /cannot start|did not answer|ENOENT/i)
	await broken.dispose()
})

test('rejects reserved binding globals', async () => {
	assert.throws(
		() => spec('pass', {}, { bindings: [{ global: 'console', functions: {} }] }),
		/reserved/,
	)
	assert.throws(
		() =>
			spec('pass', {}, {
				bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'ToolCallError', memberNameProperty: 'stack' } }],
			}),
		/reserved/,
	)
})

for (const { label, fn } of pending) {
	const started = Date.now()
	try {
		await fn()
		results.push({ label, ok: true, ms: Date.now() - started })
	} catch (error) {
		results.push({ label, ok: false, ms: Date.now() - started, error })
	}
}

await runtime.dispose()

let failed = 0
for (const row of results) {
	if (row.ok) console.log(`ok   ${String(row.ms).padStart(5)} ms  ${row.label}`)
	else {
		failed += 1
		console.log(`FAIL ${String(row.ms).padStart(5)} ms  ${row.label}`)
		console.log(String(row.error?.stack ?? row.error).replace(/^/gm, '     '))
	}
}
console.log(`\n${results.length - failed}/${results.length} cases passed`)
process.exit(failed === 0 ? 0 : 1)
