// Minimal ambient types for the `bun:test` members used by scripts/*.test.ts.
//
// The project typechecks with `tsc -b --noEmit` and does not depend on
// `bun-types`, so this declares only the surface the QA tests actually call.
declare module 'bun:test' {
  type Fn = () => void | Promise<void>;

  export function describe(name: string, fn: Fn): void;
  export function test(name: string, fn: Fn): void;

  export interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toBeGreaterThan(expected: number): void;
    toContain(expected: string): void;
    toStartWith(expected: string): void;
    toHaveLength(expected: number): void;
  }

  export function expect(actual: unknown): Matchers;

  export const mock: {
    module(path: string, factory: () => unknown): void;
  };
}
