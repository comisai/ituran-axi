// One command table drives parsing, --help and every usage line.

import type { HttpDeps } from '../http.ts';

export type FlagType = 'string' | 'boolean';

export interface FlagSpec {
  type: FlagType;
  multiple?: true;
  /** Shown without brackets in the usage line; the command checks it. */
  required?: true;
  /** Placeholder for a string flag's value, such as <n>. */
  value?: string;
  summary: string;
}

export interface ArgSpec {
  name: string;
  required: boolean;
  /** The last argument may repeat. */
  variadic?: true;
}

export type Values = Record<string, string | string[] | boolean | undefined>;

export interface Io {
  stdout: (text: string) => void;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  http: HttpDeps;
}

export type Token =
  | { kind: 'option'; name: string; value: string | undefined }
  | { kind: 'positional'; value: string };

export interface CommandInput {
  values: Values;
  positionals: string[];
  /** Flags and arguments in the order given. */
  tokens: Token[];
  io: Io;
}

export interface CommandSpec {
  /** Empty for the home view. */
  name: string;
  args: ArgSpec[];
  flags: Record<string, FlagSpec>;
  summary: string;
  run: (input: CommandInput) => Promise<string>;
}

export const BIN = 'ituran-axi';

export function commandName(spec: CommandSpec): string {
  return spec.name ? `${BIN} ${spec.name}` : BIN;
}

export function usageLine(spec: CommandSpec): string {
  const args = spec.args.map((a) => {
    const name = a.variadic ? `${a.name}...` : a.name;
    return a.required ? name : `[${name}]`;
  });
  const flags = Object.entries(spec.flags).map(([name, f]) => {
    const text =
      f.type === 'string' ? `--${name} ${f.value ?? '<value>'}` : `--${name}`;
    const shown = f.required ? text : `[${text}]`;
    return f.multiple ? `${shown}...` : shown;
  });
  return [commandName(spec), ...args, ...flags].join(' ');
}
