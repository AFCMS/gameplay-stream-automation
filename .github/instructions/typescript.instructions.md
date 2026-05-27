---
description: Instructions for TypeScript files
applyTo: "**/*.ts,**/*.tsx"
---

# Imports

Imports must be ordered as follows:

1. External packages from `node_modules`, `react` first, then other packages alphabetically.
2. Relative imports from the current package

Each of these groups must be separated by a single blank line.

# Interfaces, Types and objects

When defining interfaces, always use the `readonly` modifier when possible.

When defining objects that should typically not be modified in their lifetime, use `as const` to ensure immutability (except literals like string or numbers which don't need `as const`).

When definin arrays, prefer using `readonly` arrays (`readonly T[]`) over mutable arrays (`T[]`) when the array should not be modified after creation.

Prefer to use `readonly T[]` instead of `ReadonlyArray<T>` for defining readonly arrays, as it is more concise and easier to read.

When defining constant objects, prefer to use `satisfies` to ensure that the object conforms to a specific type without losing the literal types of its properties. This allows for better type safety and inference while maintaining the immutability of the object:

```typescript
interface MyInterface {
  readonly id: string;
  readonly name: string;
}

const object = {
  id: "123",
  name: "Example",
} as const satisfies MyInterface;
```
