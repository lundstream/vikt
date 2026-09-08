import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { createDb, type Db } from "./index.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

const plugin: FastifyPluginAsync<{ databaseUrl: string }> = async (app, options) => {
  const { db, client } = createDb(options.databaseUrl);
  app.decorate("db", db);
  app.addHook("onClose", async () => {
    await client.end({ timeout: 5 });
  });
};

export const dbPlugin = fp(plugin, { name: "db" });
