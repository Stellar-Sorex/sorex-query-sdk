import { GraphQLError, visit, type ValidationContext } from "graphql";

/**
 * Extra validation rule that rejects documents above a field-count budget.
 * Depth is handled by Mercurius' built-in `queryDepth`; this bounds wide
 * queries with many aliases and fragments.
 */
export function complexityLimit(maxFields: number) {
  return (context: ValidationContext) => {
    let fields = 0;
    return {
      Field() {
        fields += 1;
        if (fields > maxFields) {
          context.reportError(
            new GraphQLError(
              `Query complexity ${fields} exceeds the configured maximum of ${maxFields} fields`,
              { extensions: { code: "QUERY_TOO_COMPLEX" } },
            ),
          );
        }
      },
    };
  };
}

/** Count all field nodes in a document including fragment definitions. */
export function countFields(document: import("graphql").DocumentNode): number {
  let count = 0;
  visit(document, {
    Field() {
      count += 1;
    },
  });
  return count;
}
