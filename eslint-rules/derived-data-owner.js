/**
 * A table whose meaning is defined by a shared module may only be read by that
 * module.
 *
 * Five defects across five phases had the same shape: a correct rule in a
 * shared module, and call sites that reached past it. The largest was intake
 * resolution (D44), where `calc/intake.ts` had defined a day's intake since
 * Phase 2 and **four** call sites each assembled the index themselves, each
 * passing the manual rows only. Nothing errored. Days logged with food counted
 * as unlogged, which fed straight into the §4.2 coverage gate and the
 * maintenance figure.
 *
 * The Phase 6 guards catch the typeable version of this — a class name that
 * does not exist, a number rendered without the formatter. This one is not
 * typeable: `listManualIntake(userId, db, {})` is a perfectly well-typed call.
 * The only thing wrong with it is *who is making it*.
 *
 * So ownership is declared. Each entry names a table, the module that owns its
 * meaning, and the files allowed to touch it. Everything else has to go
 * through the owner, which is the property that makes the fix stay fixed:
 * forgetting the food half of intake is no longer something a call site can do.
 *
 * Deliberately shallow. It matches identifiers, not data flow, so it is a
 * signpost at the point of temptation rather than a proof. That is the right
 * trade for a rule whose job is to make someone stop and read the owner's
 * doc comment.
 */

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Tables whose meaning lives in a shared module are read only by that module.",
    },
    schema: [
      {
        type: "object",
        properties: {
          owners: {
            type: "array",
            items: {
              type: "object",
              properties: {
                /** Drizzle table identifiers, as imported from schema.ts. */
                tables: { type: "array", items: { type: "string" } },
                /** Repository functions that read them. */
                readers: { type: "array", items: { type: "string" } },
                /** Path fragments allowed to use either. */
                allow: { type: "array", items: { type: "string" } },
                /** What to reach for instead. */
                use: { type: "string" },
                why: { type: "string" },
              },
              required: ["tables", "readers", "allow", "use"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bypass:
        "`{{name}}` reads {{table}} directly. Use {{use}} instead: {{why}}",
    },
  },

  create(context) {
    const owners = context.options[0]?.owners ?? [];
    const filename = (context.filename ?? context.getFilename()).replaceAll("\\", "/");

    /** The owners this file is *not* allowed to bypass. */
    const enforced = owners.filter(
      (owner) => !owner.allow.some((fragment) => filename.includes(fragment)),
    );
    if (enforced.length === 0) return {};

    /**
     * Only flags what is actually imported. A local variable that happens to be
     * called `foodEntries` is not a table access, and reporting it would be the
     * kind of noise that gets a rule switched off.
     */
    const imported = new Map();

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        if (!source.includes("schema") && !source.includes("repositories")) return;

        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const name = specifier.imported.name;

          for (const owner of enforced) {
            if (owner.tables.includes(name) || owner.readers.includes(name)) {
              imported.set(specifier.local.name, { owner, name });
            }
          }
        }
      },

      Identifier(node) {
        const hit = imported.get(node.name);
        if (!hit) return;
        // The import itself is where the name is introduced, not a use of it.
        if (node.parent?.type === "ImportSpecifier") return;

        context.report({
          node,
          messageId: "bypass",
          data: {
            name: hit.name,
            table: hit.owner.tables.join(" / "),
            use: hit.owner.use,
            why: hit.owner.why ?? "the shared module defines what these rows mean.",
          },
        });
      },
    };
  },
};

export default { rules: { "derived-data-owner": rule } };
