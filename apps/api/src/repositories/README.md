# Repositories

Thin data access. One file per aggregate. No business logic, no HTTP, no
session handling.

## The rule (CLAUDE.md §3)

**No repository function may accept an unscoped filter on a user-owned table.**

Concretely:

- Every function that reads or writes a table carrying `user_id` takes
  `userId: string` as its **first parameter** and puts `eq(table.userId, userId)`
  into the `where`, always, even when another column is already unique. A lookup
  by primary key still gets the `user_id` predicate — that is what turns an IDOR
  into a 404.
- A function may not take a caller-supplied `where`, `filter`, or `sql` fragment.
  If a query shape is needed, add a named function for it here.
- Tables that are genuinely not user-owned — `invites`, `food_items`, `groups` —
  are the only exceptions, and each one carries a comment saying so.

`eslint-rules/user-id-first-param.js` enforces the first-parameter half of this
mechanically. The unscoped-`where` half is a review rule: treat any query in a
diff that touches a user-owned table without a `user_id` predicate as a defect,
not as a style note.

## Numbers

`numeric` columns cross this boundary as strings. Repositories return rows as
Drizzle hands them over; the **service** layer parses them with
`shared/parse.ts` so that everything above it is plain `number`.
