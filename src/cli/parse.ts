// Strict parsing with node:util parseArgs, following the Comis AXI fixture:
// unknown flags, repeated single flags, extra arguments and values on boolean
// flags are refused. A refusal names the flag, never its value. "--" ends flags.

import { parseArgs } from 'node:util';
import { usage } from '../errors.ts';
import {
  type CommandSpec,
  commandName,
  type Token,
  type Values,
} from './table.ts';

export interface Parsed {
  values: Values;
  positionals: string[];
  tokens: Token[];
}

const shownFlag = (raw: string) =>
  /^--?[A-Za-z0-9][A-Za-z0-9-]{0,40}$/.test(raw) ? raw : 'that flag';

export function parseCommand(spec: CommandSpec, argv: string[]): Parsed {
  const name = commandName(spec);
  const options: Record<
    string,
    { type: 'string' | 'boolean'; multiple?: boolean }
  > = {};
  for (const [flag, f] of Object.entries(spec.flags)) {
    options[flag] = f.multiple
      ? { type: f.type, multiple: true }
      : { type: f.type };
  }
  const valid = Object.keys(spec.flags).map((f) => `--${f}`);
  let result: ReturnType<
    typeof parseArgs<{
      options: typeof options;
      strict: false;
      allowPositionals: true;
      tokens: true;
    }>
  >;
  try {
    result = parseArgs({
      args: argv,
      options,
      strict: false,
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    throw usage(`Invalid arguments for \`${name}\`.`);
  }
  const seen = new Set<string>();
  for (const token of result.tokens) {
    if (token.kind !== 'option') continue;
    const f = spec.flags[token.name];
    if (!f) {
      throw usage(
        `Unknown flag ${shownFlag(token.rawName)} for \`${name}\`. ${valid.length ? `Valid flags: ${valid.join(', ')}.` : 'It takes no flags.'}`,
      );
    }
    if (f.type === 'boolean' && token.inlineValue)
      throw usage(`--${token.name} takes no value.`);
    if (
      f.type === 'string' &&
      (token.value === undefined || token.value === '')
    ) {
      throw usage(
        `--${token.name} needs a value: --${token.name} ${f.value ?? '<value>'}.`,
      );
    }
    if (!f.multiple && seen.has(token.name))
      throw usage(`--${token.name} is given more than once.`);
    seen.add(token.name);
  }
  const positionals = result.positionals;
  const required = spec.args.filter((a) => a.required);
  if (positionals.length < required.length) {
    throw usage(
      `Missing ${required[positionals.length]?.name ?? 'argument'} for \`${name}\`.`,
    );
  }
  const variadic = spec.args.at(-1)?.variadic === true;
  if (!variadic && positionals.length > spec.args.length) {
    throw usage(
      spec.args.length
        ? `\`${name}\` takes ${spec.args.map((a) => a.name).join(' ')}; there is an extra argument.`
        : `\`${name}\` takes no arguments.`,
    );
  }
  const tokens: Token[] = [];
  for (const token of result.tokens) {
    if (token.kind === 'option') {
      tokens.push({ kind: 'option', name: token.name, value: token.value });
    } else if (token.kind === 'positional') {
      tokens.push({ kind: 'positional', value: token.value });
    }
  }
  return { values: result.values as Values, positionals, tokens };
}
