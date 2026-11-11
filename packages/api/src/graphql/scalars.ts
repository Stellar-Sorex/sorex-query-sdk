import { GraphQLScalarType, Kind, type ValueNode } from "graphql";
import type { JsonValue } from "../types.js";

function parseLiteral(node: ValueNode, variables?: Record<string, unknown> | null): JsonValue {
  switch (node.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return node.value;
    case Kind.INT:
      return Number(node.value);
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map((value) => parseLiteral(value, variables));
    case Kind.OBJECT: {
      const result: { [key: string]: JsonValue } = {};
      for (const field of node.fields) {
        result[field.name.value] = parseLiteral(field.value, variables);
      }
      return result;
    }
    case Kind.VARIABLE:
      return (variables?.[node.name.value] as JsonValue) ?? null;
    default:
      return null;
  }
}

/** Pass-through JSON scalar for decoded SCVal structures. */
export const jsonScalar = new GraphQLScalarType({
  name: "JSON",
  description: "JSON-safe decoded SCVal data (big integers are decimal strings).",
  serialize: (value) => value,
  parseValue: (value) => value as JsonValue,
  parseLiteral,
});
