# Services

All business logic. Routes are thin: validate, pull `userId` off the request,
call a service, serialise. Services never see a Fastify request or reply.

## The rule (CLAUDE.md §3)

**Every service function takes `userId` as its first parameter.** Not inside an
options object, not derived from something else that was passed in, not
optional. First positional parameter, named `userId`, typed `string`.

```ts
// yes
export async function getWeightLog(userId: string, db: Db, range: DateRange) {}

// no — the scope is buried and easy to forget at the call site
export async function getWeightLog(db: Db, opts: { userId: string }) {}
```

This is enforced by `eslint-rules/user-id-first-param.js`, wired up in
`eslint.config.js` for `apps/api/src/services/**` and `apps/api/src/repositories/**`.
The rule fires on every exported function whose name is not in its
`allowUnscoped` list. Adding a name to that list is a deliberate, reviewable act
— it is how `authenticate`, `register` and the invite functions opt out, since
they run *before* there is a user to scope to.

## Why the first parameter specifically

Because the failure mode is silent. An unscoped read returns somebody else's
rows and looks completely normal in every test that only ever has one user in
the database. Putting the scope in position one means a call site that forgot it
does not compile, rather than shipping and quietly leaking.

## Numbers

Services own the `numeric` boundary: repositories hand back strings, services
convert with `toNumber` / `toNumeric` from `shared/parse.ts`, and everything
above this layer is plain `number`.
