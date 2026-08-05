import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { COMMAND_CAPABILITIES, commandCapability } from '../src/core/access/commands'
import { buildProgram } from '../src/program'

/** Every runnable command path (a command with no subcommands of its own). */
function leafPaths(command: Command, prefix: string[]): string[] {
  const here = [...prefix, command.name()]
  const children = command.commands as Command[]
  if (children.length === 0) return [here.join(' ')]
  return children.flatMap((child) => leafPaths(child, here))
}

describe('COMMAND_CAPABILITIES covers the CLI exactly', () => {
  const paths = (buildProgram().commands as Command[]).flatMap((c) => leafPaths(c, []))

  it('finds a non-trivial command tree', () => {
    expect(paths.length).toBeGreaterThan(60)
    expect(new Set(paths).size).toBe(paths.length) // no duplicate paths
  })

  it('declares a capability for every command', () => {
    // A command with no entry falls back to `project.manage` (fail closed), which
    // would lock every non-admin out of it. That default is a backstop, not a
    // design — anything missing here is a bug in the new command, not in the map.
    const missing = paths.filter((p) => commandCapability(p) === undefined)
    expect(missing).toEqual([])
  })

  it('has no entries for commands that no longer exist', () => {
    const live = new Set(paths)
    expect(Object.keys(COMMAND_CAPABILITIES).filter((p) => !live.has(p))).toEqual([])
  })

  it('gates the obvious write paths and leaves reads readable', () => {
    expect(commandCapability('wiki new')).toBe('write')
    expect(commandCapability('wiki rm')).toBe('delete')
    expect(commandCapability('wiki get')).toBe('read')
    expect(commandCapability('config set')).toBe('config.write')
    expect(commandCapability('access user add')).toBe('users.manage')
    // Deliberately ungated so a locked-out member can find out why.
    expect(commandCapability('whoami')).toBeNull()
    expect(commandCapability('access status')).toBeNull()
    expect(commandCapability('project join')).toBeNull()
  })
})
