import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createHabitCheckSchema,
  createHabitSchema,
  errorResponseSchema,
  habitCheckSchema,
  habitDeleteQuerySchema,
  habitListSchema,
  habitSchema,
  reorderHabitsSchema,
  updateHabitSchema,
  HABIT_MAX,
} from "shared";
import {
  createHabit,
  editHabit,
  getHabits,
  HabitLimitReached,
  removeHabit,
  reorderHabits,
  saveHabitCheck,
} from "../services/habit.service.js";

/**
 * The habit checklist (D137).
 *
 * Every handler passes `request.userId` as the first argument and never reads
 * an id from the body. A habit name is health data (D107) and a checklist is a
 * medication schedule as often as it is a stretching routine, so an unscoped
 * read here is the same defect class as an unscoped weight read.
 *
 * `POST /habit-check` is the one the offline queue replays, which is why it is
 * an upsert answering 200 rather than a 201 with a location.
 */
export const habitRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/habits",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: habitListSchema, 401: errorResponseSchema } },
    },
    async (request) => ({ habits: await getHabits(request.userId!, app.db) }),
  );

  app.post(
    "/habits",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createHabitSchema,
        response: {
          200: habitSchema,
          401: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return await createHabit(request.userId!, app.db, request.body);
      } catch (error) {
        if (error instanceof HabitLimitReached) {
          /**
           * A stated limit rather than a silent one. §3 has no failure state,
           * but a list that quietly stops accepting rows is worse than one that
           * says how many it holds.
           */
          return reply.code(422).send({
            error: "habit_limit",
            message: `Listan rymmer ${HABIT_MAX} vanor. Ta bort någon först.`,
          });
        }
        throw error;
      }
    },
  );

  app.patch(
    "/habits/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: updateHabitSchema,
        response: { 200: habitSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const habit = await editHabit(request.userId!, app.db, request.params.id, request.body);
      if (habit === null) {
        return reply.code(404).send({ error: "not_found", message: "Ingen sådan vana." });
      }
      return habit;
    },
  );

  /** The whole order at once, so a move is one write and cannot half-apply. */
  app.post(
    "/habits/reorder",
    {
      preHandler: app.requireAuth,
      schema: {
        body: reorderHabitsSchema,
        response: { 200: habitListSchema, 401: errorResponseSchema },
      },
    },
    async (request) => ({
      habits: await reorderHabits(request.userId!, app.db, request.body.ids),
    }),
  );

  /**
   * Removing a habit. `?history=keep` (the default) archives it and the ticks
   * stay; `?history=remove` deletes both. The screen says which before asking.
   */
  app.delete(
    "/habits/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: habitDeleteQuerySchema,
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const removed = await removeHabit(
        request.userId!,
        app.db,
        request.params.id,
        request.query.history,
      );
      if (!removed) {
        return reply.code(404).send({ error: "not_found", message: "Ingen sådan vana." });
      }
      return reply.code(204).send(null);
    },
  );

  /**
   * Ticking and unticking, replayable by the offline queue.
   *
   * Answers with the streak as it now stands, so one tap is one round trip: the
   * number beside the row moves without a second request, which is the request
   * a queued tick could not make anyway.
   */
  app.post(
    "/habit-check",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createHabitCheckSchema,
        response: {
          200: habitCheckSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await saveHabitCheck(request.userId!, app.db, request.body);
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: "Ingen sådan vana." });
      }
      return result;
    },
  );
};
