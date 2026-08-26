#!/usr/bin/env python3
# Seek — protocol code generator.
# Copyright (C) 2026 Seek contributors.
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Reads shared/schema.py and writes:
#   shared/protocol.ts                  (consumed by app/, via data/adapt.ts)
#   sidecar/seek_sidecar/protocol.py    (consumed by the sidecar)
#
#   python3 shared/generate_protocol.py           # write both
#   python3 shared/generate_protocol.py --check   # exit 1 if either is stale
#
# The two outputs are checked in so neither side needs a build step to read the
# protocol. `sidecar/tests/test_protocol_sync.py` runs --check.

import argparse
import os
import sys
import textwrap

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import schema  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_OUT = os.path.join(ROOT, "shared", "protocol.ts")
PY_OUT = os.path.join(ROOT, "sidecar", "seek_sidecar", "protocol.py")

PRIMITIVES_TS = {"str": "string", "int": "number", "float": "number",
                 "bool": "boolean", "json": "unknown"}
PRIMITIVES_PY = {"str": "str", "int": "int", "float": "float",
                 "bool": "bool", "json": "object"}

BANNER = (
    "GENERATED FILE — DO NOT EDIT.\n"
    "Source of truth: shared/schema.py\n"
    "Regenerate:      python3 shared/generate_protocol.py\n"
    "Verified by:     sidecar/tests/test_protocol_sync.py"
)


# ---------------------------------------------------------------- type parsing

def parse_type(spec):
    """'Foo[]?' -> ('Foo', is_array=True, nullable=True)."""
    nullable = False
    is_array = False
    t = spec
    if t.endswith("?"):
        nullable = True
        t = t[:-1]
    if t.endswith("[]"):
        is_array = True
        t = t[:-2]
    if t.endswith("?"):
        raise ValueError(f"nullable element types are not expressible: {spec!r}")
    known = set(PRIMITIVES_TS) | set(schema.STRUCTS) | set(schema.ENUMS)
    if t not in known:
        raise ValueError(f"unknown type {t!r} in {spec!r}")
    return t, is_array, nullable


def check_schema():
    for name, (_doc, fields) in schema.STRUCTS.items():
        seen = set()
        for field, spec, _fdoc in fields:
            if field in seen:
                raise ValueError(f"{name}.{field} declared twice")
            seen.add(field)
            parse_type(spec)
    for name, (_doc, params, result) in schema.COMMANDS.items():
        for ref in (params, result):
            if ref is not None and ref not in schema.STRUCTS:
                raise ValueError(f"command {name} references unknown struct {ref}")
    for name, (_doc, payload) in schema.EVENTS.items():
        if payload not in schema.STRUCTS:
            raise ValueError(f"event {name} references unknown struct {payload}")


# ------------------------------------------------------------------ formatting

def wrap(text, width, indent):
    out = []
    for para in text.split("\n"):
        if not para.strip():
            out.append("")
            continue
        out.extend(textwrap.wrap(para, width=width,
                                 break_long_words=False, break_on_hyphens=False)
                   or [""])
    return [indent + line if line else indent.rstrip() for line in out]


def ts_doc(text, indent=""):
    if not text:
        return []
    lines = wrap(text, 76 - len(indent), "")
    if len(lines) == 1:
        return [f"{indent}/** {lines[0]} */"]
    body = [f"{indent} * {ln}".rstrip() for ln in lines]
    return [f"{indent}/**", *body, f"{indent} */"]


def py_doc(text, indent):
    if not text:
        return []
    lines = wrap(text, 76 - len(indent), "")
    if len(lines) == 1:
        return [f'{indent}"""{lines[0]}"""']
    body = [f"{indent}{ln}".rstrip() for ln in lines]
    return [f'{indent}"""', *body, f'{indent}"""']


# ------------------------------------------------------------------ TypeScript

def ts_type(spec):
    t, is_array, nullable = parse_type(spec)
    base = PRIMITIVES_TS.get(t, t)
    if is_array:
        base = f"{base}[]"
    if nullable:
        base = f"{base} | null"
    return base


def generate_ts():
    L = []
    L.append("/*")
    for line in BANNER.split("\n"):
        L.append(f" * {line}")
    L.append(" *")
    L.append(" * Seek — wire protocol between the Python sidecar and the app.")
    L.append(" * Copyright (C) 2026 Seek contributors.")
    L.append(" * SPDX-License-Identifier: GPL-3.0-or-later")
    L.append(" *")
    L.append(" * Transport: localhost WebSocket, newline-delimited JSON, one frame per")
    L.append(" * message. The sidecar emits RAW data only — no formatting, no derived")
    L.append(" * fields, no ranking. Grouping, dedup, quality scoring and all display")
    L.append(" * formatting belong to app/src/domain/.")
    L.append(" */")
    L.append("")
    L.append(f"export const PROTOCOL_VERSION = {schema.PROTOCOL_VERSION};")
    L.append("")

    L.append("/* ---------------------------------------------------------------- enums */")
    L.append("")
    for name, (doc, values) in schema.ENUMS.items():
        L.extend(ts_doc(doc))
        opts = " | ".join(f"'{v}'" for v in values)
        decl = f"export type {name} = {opts};"
        if len(decl) <= 96:
            L.append(decl)
        else:
            L.append(f"export type {name} =")
            for i, v in enumerate(values):
                sep = ";" if i == len(values) - 1 else ""
                L.append(f"  | '{v}'{sep}")
        L.append("")

    L.append("/* -------------------------------------------------------------- structs */")
    L.append("")
    for name, (doc, fields) in schema.STRUCTS.items():
        L.extend(ts_doc(doc))
        L.append(f"export interface {name} {{")
        for i, (field, spec, fdoc) in enumerate(fields):
            if fdoc:
                if i:
                    L.append("")
                L.extend(ts_doc(fdoc, "  "))
            L.append(f"  {field}: {ts_type(spec)};")
        L.append("}")
        L.append("")

    L.append("/* ------------------------------------------------------------- envelope */")
    L.append("")
    L.extend(ts_doc("A command frame, client -> sidecar. `id` is chosen by the client and "
                    "echoed back on the reply."))
    L.append("export interface Request<C extends CommandName = CommandName> {")
    L.append("  id: string;")
    L.append("  cmd: C;")
    L.append("  params: CommandParams[C];")
    L.append("}")
    L.append("")
    L.extend(ts_doc("A reply frame, sidecar -> client. Exactly one per Request."))
    L.append("export type Response<C extends CommandName = CommandName> =")
    L.append("  | { id: string; ok: true; result: CommandResult[C] }")
    L.append("  | { id: string; ok: false; error: ErrorInfo };")
    L.append("")
    L.extend(ts_doc("An unsolicited event frame, sidecar -> client."))
    L.append("export interface Event<E extends EventName = EventName> {")
    L.append("  ev: E;")
    L.append("  data: EventPayload[E];")
    L.append("}")
    L.append("")
    L.extend(ts_doc("Anything that can arrive from the sidecar."))
    L.append("export type Frame = Response | Event;")
    L.append("")
    L.append("export function isEvent(frame: Frame): frame is Event {")
    L.append("  return (frame as Event).ev !== undefined;")
    L.append("}")
    L.append("")

    L.append("/* ------------------------------------------------------- command tables */")
    L.append("")
    L.append("export interface CommandParams {")
    for name, (doc, params, _result) in schema.COMMANDS.items():
        if doc:
            L.extend(ts_doc(doc, "  "))
        L.append(f"  '{name}': {params if params else 'Record<string, never>'};")
    L.append("}")
    L.append("")
    L.append("export interface CommandResult {")
    for name, (_doc, _params, result) in schema.COMMANDS.items():
        L.append(f"  '{name}': {result if result else 'Record<string, never>'};")
    L.append("}")
    L.append("")
    L.append("export type CommandName = keyof CommandParams;")
    L.append("")
    L.append("export const COMMAND_NAMES = [")
    for name in schema.COMMANDS:
        L.append(f"  '{name}',")
    L.append("] as const satisfies readonly CommandName[];")
    L.append("")

    L.append("/* --------------------------------------------------------- event tables */")
    L.append("")
    L.append("export interface EventPayload {")
    for name, (doc, payload) in schema.EVENTS.items():
        if doc:
            L.extend(ts_doc(doc, "  "))
        L.append(f"  '{name}': {payload};")
    L.append("}")
    L.append("")
    L.append("export type EventName = keyof EventPayload;")
    L.append("")
    L.append("export const EVENT_NAMES = [")
    for name in schema.EVENTS:
        L.append(f"  '{name}',")
    L.append("] as const satisfies readonly EventName[];")
    L.append("")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------------- Python

def py_type(spec):
    t, is_array, nullable = parse_type(spec)
    if t in PRIMITIVES_PY:
        base = PRIMITIVES_PY[t]
    elif t in schema.ENUMS:
        base = f'"{t}"'
    else:
        base = f'"{t}"'
    if is_array:
        base = f"List[{base}]"
    if nullable:
        base = f"Optional[{base}]"
    return base


def generate_py():
    L = []
    L.append('"""')
    for line in BANNER.split("\n"):
        L.append(line)
    L.append("")
    L.append("Seek — wire protocol, Python side.")
    L.append("Copyright (C) 2026 Seek contributors.")
    L.append("SPDX-License-Identifier: GPL-3.0-or-later")
    L.append("")
    L.append("TypedDicts mirror shared/protocol.ts exactly. VALIDATORS is a runtime")
    L.append("description of the same schema, used by validate() to check every frame")
    L.append("the sidecar emits and every command it accepts — TypedDicts are erased at")
    L.append("runtime, so they alone would prove nothing.")
    L.append('"""')
    L.append("")
    L.append("from typing import Dict, List, Literal, Optional, Tuple, TypedDict")
    L.append("")
    L.append(f"PROTOCOL_VERSION = {schema.PROTOCOL_VERSION}")
    L.append("")
    L.append("")
    L.append("# ----------------------------------------------------------------- enums")
    L.append("")
    for name, (doc, values) in schema.ENUMS.items():
        opts = ", ".join(f'"{v}"' for v in values)
        decl = f"{name} = Literal[{opts}]"
        if len(decl) <= 88:
            L.append(decl)
        else:
            L.append(f"{name} = Literal[")
            for v in values:
                L.append(f'    "{v}",')
            L.append("]")
        if doc:
            L.extend(py_doc(doc, ""))
        L.append("")
    L.append("")
    L.append(f"ENUM_VALUES: Dict[str, Tuple[str, ...]] = {{")
    for name, (_doc, values) in schema.ENUMS.items():
        vals = ", ".join(f'"{v}"' for v in values)
        L.append(f'    "{name}": ({vals},),')
    L.append("}")
    L.append("")
    L.append("")
    L.append("# --------------------------------------------------------------- structs")
    L.append("")
    for name, (doc, fields) in schema.STRUCTS.items():
        L.append(f"class {name}(TypedDict):")
        if doc:
            L.extend(py_doc(doc, "    "))
        for field, spec, fdoc in fields:
            if fdoc:
                for ln in wrap(fdoc, 72, "    # "):
                    L.append(ln.rstrip())
            L.append(f"    {field}: {py_type(spec)}")
        L.append("")
        L.append("")

    L.append("# ------------------------------------------------------ runtime validator")
    L.append("")
    L.append("# name -> ((field, base_type, is_array, nullable), ...)")
    L.append("STRUCT_FIELDS: Dict[str, Tuple[Tuple[str, str, bool, bool], ...]] = {")
    for name, (_doc, fields) in schema.STRUCTS.items():
        L.append(f'    "{name}": (')
        for field, spec, _fdoc in fields:
            t, is_array, nullable = parse_type(spec)
            L.append(f'        ("{field}", "{t}", {is_array}, {nullable}),')
        L.append("    ),")
    L.append("}")
    L.append("")
    L.append("COMMANDS: Dict[str, Tuple[Optional[str], Optional[str]]] = {")
    for name, (_doc, params, result) in schema.COMMANDS.items():
        p = f'"{params}"' if params else "None"
        r = f'"{result}"' if result else "None"
        L.append(f'    "{name}": ({p}, {r}),')
    L.append("}")
    L.append("")
    L.append("EVENTS: Dict[str, str] = {")
    for name, (_doc, payload) in schema.EVENTS.items():
        L.append(f'    "{name}": "{payload}",')
    L.append("}")
    L.append("")
    L.append('COMMAND_NAMES = tuple(COMMANDS)')
    L.append('EVENT_NAMES = tuple(EVENTS)')
    L.append("")
    L.append("")
    L.append(_VALIDATOR_BODY.strip("\n"))
    L.append("")
    return "\n".join(L) + "\n"


_VALIDATOR_BODY = '''
class SchemaError(ValueError):
    """A payload did not match the generated schema."""


_PRIMITIVE_CHECKS = {
    "str": lambda v: isinstance(v, str),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "float": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "bool": lambda v: isinstance(v, bool),
    "json": lambda v: True,
}


def _check_value(value, base, path):
    if base in _PRIMITIVE_CHECKS:
        if not _PRIMITIVE_CHECKS[base](value):
            raise SchemaError(
                f"{path}: expected {base}, got {type(value).__name__} ({value!r})"
            )
        return
    if base in ENUM_VALUES:
        if value not in ENUM_VALUES[base]:
            raise SchemaError(
                f"{path}: {value!r} is not a valid {base} "
                f"(expected one of {', '.join(ENUM_VALUES[base])})"
            )
        return
    validate_struct(base, value, path)


def validate_struct(name, value, path=""):
    """Raise SchemaError unless `value` is a valid `name`.

    Checks presence, type, nullability and — crucially — rejects unknown keys.
    A typo in an emitter is otherwise invisible until it reaches TypeScript.
    """
    fields = STRUCT_FIELDS.get(name)
    if fields is None:
        raise SchemaError(f"{path or '<root>'}: unknown struct {name!r}")
    if not isinstance(value, dict):
        raise SchemaError(
            f"{path or name}: expected object, got {type(value).__name__}"
        )

    prefix = f"{path}." if path else f"{name}."
    known = set()

    for field, base, is_array, nullable in fields:
        known.add(field)
        if field not in value:
            raise SchemaError(f"{prefix}{field}: missing")
        item = value[field]
        if item is None:
            if not nullable:
                raise SchemaError(f"{prefix}{field}: null not allowed")
            continue
        if is_array:
            if not isinstance(item, list):
                raise SchemaError(
                    f"{prefix}{field}: expected array, got {type(item).__name__}"
                )
            for i, element in enumerate(item):
                _check_value(element, base, f"{prefix}{field}[{i}]")
            continue
        _check_value(item, base, f"{prefix}{field}")

    extra = set(value) - known
    if extra:
        raise SchemaError(
            f"{prefix.rstrip('.')}: unknown field(s) {', '.join(sorted(extra))}"
        )


def validate_event(name, data):
    """Raise SchemaError unless `data` is a valid payload for event `name`."""
    payload = EVENTS.get(name)
    if payload is None:
        raise SchemaError(f"unknown event {name!r}")
    validate_struct(payload, data, payload)


def validate_command(name, params):
    """Raise SchemaError unless `params` is valid for command `name`."""
    entry = COMMANDS.get(name)
    if entry is None:
        raise SchemaError(f"unknown command {name!r}")
    struct = entry[0]
    if struct is None:
        if params not in (None, {}):
            raise SchemaError(f"{name}: expected no params, got {params!r}")
        return
    validate_struct(struct, params, struct)


def validate_result(name, result):
    """Raise SchemaError unless `result` is valid for command `name`."""
    entry = COMMANDS.get(name)
    if entry is None:
        raise SchemaError(f"unknown command {name!r}")
    struct = entry[1]
    if struct is None:
        if result not in (None, {}):
            raise SchemaError(f"{name}: expected no result, got {result!r}")
        return
    validate_struct(struct, result, struct)
'''


# ------------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="verify checked-in outputs are current; exit 1 if not")
    args = ap.parse_args()

    check_schema()
    outputs = [(TS_OUT, generate_ts()), (PY_OUT, generate_py())]

    if args.check:
        stale = []
        for path, content in outputs:
            try:
                with open(path, encoding="utf-8") as handle:
                    current = handle.read()
            except FileNotFoundError:
                stale.append(f"{os.path.relpath(path, ROOT)} (missing)")
                continue
            if current != content:
                stale.append(os.path.relpath(path, ROOT))
        if stale:
            print("stale generated files: " + ", ".join(stale), file=sys.stderr)
            print("run: python3 shared/generate_protocol.py", file=sys.stderr)
            return 1
        print("protocol outputs are current")
        return 0

    for path, content in outputs:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        print(f"wrote {os.path.relpath(path, ROOT)} ({len(content)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
