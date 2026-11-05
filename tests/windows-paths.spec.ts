import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Config, executable, machineOf } from '../src/deployment.ts'
import { sameDirectory, withoutDirectory } from '../src/infra/environment.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'

const directories: string[] = []
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-paths-'))
  directories.push(directory)
  return directory
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it.each(['/srv/superagent', '/srv/project with spaces'])('preserves the existing POSIX absolute-path contract: %s', path => {
  expect(machineOf(Config({ stateDir: path, assistantWorkspace: path }))).toMatchObject({ stateDir: path, assistantWorkspace: path })
  expect(ExecutorConfigSchema.parse({ directory: path }).directory).toBe(path)
})

it.each(['relative/path', 'relative\\path', '~/superagent', 'C:relative'])('rejects relative configuration paths: %s', path => {
  expect(() => Config({ stateDir: path })).toThrow()
  expect(() => machineOf(Config({ stateDir: '/srv/state', assistantWorkspace: path }))).toThrow('absolute path')
  expect(() => ExecutorConfigSchema.parse({ directory: path })).toThrow()
})

it('preserves empty optional directory defaults', () => {
  expect(machineOf(Config({ stateDir: '/srv/state' }))).not.toHaveProperty('assistantWorkspace')
  expect(ExecutorConfigSchema.parse({}).directory).toBe('')
})

it.runIf(process.platform === 'win32').each([
  String.raw`D:\Superagent State\项目`,
  'D:/Superagent State/项目',
  String.raw`\\server\share\superagent`,
])('accepts native Windows directory paths without rewriting them: %s', path => {
  expect(machineOf(Config({ stateDir: path, assistantWorkspace: path }))).toMatchObject({ stateDir: path, assistantWorkspace: path })
  expect(ExecutorConfigSchema.parse({ directory: path }).directory).toBe(path)
})

it.runIf(process.platform === 'win32')('rejects a relative backslash CLI path instead of searching for it below PATH entries', () => {
  const directory = temporary()
  mkdirSync(join(directory, 'bin'))
  writeFileSync(join(directory, 'bin', 'gh.exe'), 'test fixture')
  expect(() => executable(String.raw`bin\gh.exe`, directory)).toThrow('must be a command name or an absolute path')
})

it.runIf(process.platform === 'win32')('compares missing Windows paths case-insensitively when removing a worker directory from PATH', () => {
  const directory = temporary(), missing = join(directory, 'Worker-Bin')
  expect(sameDirectory(missing, missing.toUpperCase())).toBe(true)
  expect(withoutDirectory(`${missing};${directory}`, missing.toUpperCase())).toBe(directory)
})

it('resolves an absolute CLI file in a local path containing spaces', () => {
  const directory = temporary(), binaryDirectory = join(directory, 'CLI tools')
  mkdirSync(binaryDirectory)
  const binary = join(binaryDirectory, process.platform === 'win32' ? 'gh.exe' : 'gh')
  writeFileSync(binary, 'test fixture', { mode: 0o755 })
  expect(executable(binary, '')).toBe(binary)
})
