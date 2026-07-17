// SPDX-License-Identifier: Apache-2.0
// @allow-throw: immutable observational proxies reject subscriber mutation at the event boundary
import { tryCatch, type Result } from "@comis/shared";
import { systemDateFrom } from "../runtime/system-time.js";

const MUTATION_ERROR = "Observational event snapshots are immutable";
const TYPED_ARRAY_MUTATORS = new Set<PropertyKey>([
  "copyWithin",
  "fill",
  "reverse",
  "set",
  "sort",
]);
const ARRAY_BUFFER_MUTATORS = new Set<PropertyKey>([
  "resize",
  "transfer",
  "transferToFixedLength",
]);

function rejectMutation(): never {
  throw new TypeError(MUTATION_ERROR);
}

function immutableTraps<T extends object>(): Pick<
  ProxyHandler<T>,
  "set" | "deleteProperty" | "defineProperty" | "setPrototypeOf"
> {
  return {
    set: () => rejectMutation(),
    deleteProperty: () => rejectMutation(),
    defineProperty: () => rejectMutation(),
    setPrototypeOf: () => rejectMutation(),
  };
}

function hardenMap(
  source: Map<unknown, unknown>,
  seen: WeakMap<object, unknown>,
): ReadonlyMap<unknown, unknown> {
  const target = new Map<unknown, unknown>();
  const snapshot = new Proxy<Map<unknown, unknown>>(target, {
    ...immutableTraps<Map<unknown, unknown>>(),
    get: (map, property) => {
      if (property === "set" || property === "delete" || property === "clear") {
        return rejectMutation;
      }
      if (property === "forEach") {
        return (
          callback: (value: unknown, key: unknown, map: ReadonlyMap<unknown, unknown>) => void,
          thisArg?: unknown,
        ): void => {
          map.forEach((value, key) => callback.call(thisArg, value, key, snapshot));
        };
      }
      if (property === "valueOf") return () => snapshot;
      const member = Reflect.get(map, property, map) as unknown;
      return typeof member === "function" ? member.bind(map) : member;
    },
  });
  seen.set(source, snapshot);
  for (const [key, value] of source.entries()) {
    target.set(hardenSnapshot(key, seen), hardenSnapshot(value, seen));
  }
  Object.freeze(target);
  return snapshot;
}

function hardenSet(
  source: Set<unknown>,
  seen: WeakMap<object, unknown>,
): ReadonlySet<unknown> {
  const target = new Set<unknown>();
  const snapshot = new Proxy<Set<unknown>>(target, {
    ...immutableTraps<Set<unknown>>(),
    get: (set, property) => {
      if (property === "add" || property === "delete" || property === "clear") {
        return rejectMutation;
      }
      if (property === "forEach") {
        return (
          callback: (value: unknown, key: unknown, set: ReadonlySet<unknown>) => void,
          thisArg?: unknown,
        ): void => {
          set.forEach((value) => callback.call(thisArg, value, value, snapshot));
        };
      }
      if (property === "valueOf") return () => snapshot;
      const member = Reflect.get(set, property, set) as unknown;
      return typeof member === "function" ? member.bind(set) : member;
    },
  });
  seen.set(source, snapshot);
  for (const value of source.values()) target.add(hardenSnapshot(value, seen));
  Object.freeze(target);
  return snapshot;
}

function hardenDate(source: Date, seen: WeakMap<object, unknown>): Date {
  const target = systemDateFrom(source.getTime());
  const snapshot = new Proxy<Date>(target, {
    ...immutableTraps<Date>(),
    get: (date, property) => {
      const member = Reflect.get(date, property, date) as unknown;
      if (typeof property === "string" && property.startsWith("set") && typeof member === "function") {
        return rejectMutation;
      }
      return typeof member === "function" ? member.bind(date) : member;
    },
  });
  seen.set(source, snapshot);
  Object.freeze(target);
  return snapshot;
}

function hardenRegExp(source: RegExp, seen: WeakMap<object, unknown>): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- clone an existing compiled expression without executing it
  const target = new RegExp(source.source, source.flags);
  target.lastIndex = source.lastIndex;
  const snapshot = new Proxy<RegExp>(target, {
    ...immutableTraps<RegExp>(),
    get: (expression, property) => {
      const member = Reflect.get(expression, property, expression) as unknown;
      if (typeof member !== "function") return member;
      return (...args: unknown[]): unknown => {
        // eslint-disable-next-line security/detect-non-literal-regexp -- isolate stateful RegExp methods on a clone of the compiled expression
        const receiver = new RegExp(expression.source, expression.flags);
        receiver.lastIndex = expression.lastIndex;
        return Reflect.apply(member, receiver, args);
      };
    },
  });
  seen.set(source, snapshot);
  Object.freeze(target);
  return snapshot;
}

function hardenArrayBuffer(source: ArrayBuffer, seen: WeakMap<object, unknown>): ArrayBuffer {
  const target = source.slice(0);
  const snapshot = new Proxy<ArrayBuffer>(target, {
    ...immutableTraps<ArrayBuffer>(),
    get: (buffer, property) => {
      if (property === "valueOf") return () => snapshot;
      const member = Reflect.get(buffer, property, buffer) as unknown;
      if (ARRAY_BUFFER_MUTATORS.has(property) && typeof member === "function") {
        return rejectMutation;
      }
      return typeof member === "function" ? member.bind(buffer) : member;
    },
  });
  seen.set(source, snapshot);
  Object.freeze(target);
  return snapshot;
}

function hardenSharedArrayBuffer(
  source: SharedArrayBuffer,
  seen: WeakMap<object, unknown>,
): SharedArrayBuffer {
  const target = new SharedArrayBuffer(source.byteLength);
  new Uint8Array(target).set(new Uint8Array(source));
  const snapshot = new Proxy<SharedArrayBuffer>(target, {
    ...immutableTraps<SharedArrayBuffer>(),
    get: (buffer, property) => {
      if (property === "valueOf") return () => snapshot;
      const member = Reflect.get(buffer, property, buffer) as unknown;
      if (property === "grow" && typeof member === "function") return rejectMutation;
      return typeof member === "function" ? member.bind(buffer) : member;
    },
  });
  seen.set(source, snapshot);
  Object.freeze(target);
  return snapshot;
}

function hardenArrayBufferView(
  source: ArrayBufferView,
  seen: WeakMap<object, unknown>,
): ArrayBufferView {
  if (source instanceof DataView) {
    const copied = new ArrayBuffer(source.byteLength);
    new Uint8Array(copied).set(
      new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
    );
    const target = new DataView(copied);
    const snapshot = new Proxy<DataView>(target, {
      ...immutableTraps<DataView>(),
      get: (view, property) => {
        if (property === "buffer") return view.buffer.slice(0);
        if (property === "valueOf") return () => snapshot;
        const member = Reflect.get(view, property, view) as unknown;
        if (typeof property === "string" && property.startsWith("set") && typeof member === "function") {
          return rejectMutation;
        }
        return typeof member === "function" ? member.bind(view) : member;
      },
    });
    seen.set(source, snapshot);
    Object.freeze(target);
    return snapshot;
  }

  const sourceView = source as unknown as {
    readonly buffer: ArrayBuffer;
    readonly byteOffset: number;
    readonly byteLength: number;
    slice(): object;
  } & object;
  const target = sourceView.slice() as typeof sourceView;
  const snapshot = new Proxy<typeof target>(target, {
    ...immutableTraps<typeof target>(),
    get: (view, property) => {
      if (property === "buffer") {
        return view.buffer.slice(0);
      }
      if (property === "valueOf") return () => snapshot;
      const member = Reflect.get(view, property, view) as unknown;
      if (property === "constructor") return member;
      if (TYPED_ARRAY_MUTATORS.has(property) && typeof member === "function") return rejectMutation;
      if (typeof member !== "function") return member;
      return (...args: unknown[]): unknown => Reflect.apply(member, view.slice(), args);
    },
  });
  seen.set(source, snapshot);
  return snapshot as unknown as ArrayBufferView;
}

function hardenObject(source: object, seen: WeakMap<object, unknown>): object {
  seen.set(source, source);
  for (const property of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, property);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const value = hardenSnapshot(descriptor.value, seen);
    if (value !== descriptor.value) {
      Object.defineProperty(source, property, { ...descriptor, value });
    }
  }
  return Object.freeze(source);
}

function hardenSnapshot(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (value instanceof Map) return hardenMap(value, seen);
  if (value instanceof Set) return hardenSet(value, seen);
  if (value instanceof Date) return hardenDate(value, seen);
  if (value instanceof RegExp) return hardenRegExp(value, seen);
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return hardenSharedArrayBuffer(value, seen);
  }
  if (value instanceof ArrayBuffer) return hardenArrayBuffer(value, seen);
  if (ArrayBuffer.isView(value)) return hardenArrayBufferView(value, seen);
  return hardenObject(value, seen);
}

/** Clone one event payload and recursively remove every mutable alias. */
export function createImmutableEventSnapshot<T>(payload: T): Result<T, Error> {
  return tryCatch(() => hardenSnapshot(structuredClone(payload), new WeakMap()) as T);
}
