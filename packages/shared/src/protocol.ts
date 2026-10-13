/**
 * The WebSocket protocol. Every message is defined once here and checked on both the server and the client.
 */
import { z } from "zod";

export const PROTOCOL = "parley.v1";
export const MAX_BODY_LENGTH = 4000;
export const MAX_SYNC_LIMIT = 200;

const id = z.uuid();
const seq = z.number().int().nonnegative();

export const Message = z.object({
  id,
  channelId: id,
  seq: seq,
  senderId: id,
  body: z.string(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;

// ── client → server ──────────────────────────────────────────────────────────

export const ClientFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    channelId: id,
    clientMsgId: id,
    body: z.string().trim().min(1).max(MAX_BODY_LENGTH),
  }),
  z.object({
    type: z.literal("sync"),
    channelId: id,
    afterSeq: seq,
    limit: z.number().int().min(1).max(MAX_SYNC_LIMIT).optional(),
  }),
  z.object({ type: z.literal("subscribe"), channelIds: z.array(id).min(1).max(500) }),
  z.object({ type: z.literal("unsubscribe"), channelIds: z.array(id).min(1).max(500) }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ── server → client ──────────────────────────────────────────────────────────

export const ErrorCode = z.enum([
  "bad_request",
  "forbidden",
  "not_found",
  "rate_limited",
  "unavailable",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), userId: id, connectionId: z.string() }),
  z.object({ type: z.literal("ack"), clientMsgId: id, message: Message }),
  z.object({ type: z.literal("message"), message: Message }),
  z.object({
    type: z.literal("sync_result"),
    channelId: id,
    messages: z.array(Message),
    hasMore: z.boolean(),
  }),
  z.object({ type: z.literal("subscribed"), channelIds: z.array(id) }),
  z.object({ type: z.literal("unsubscribed"), channelIds: z.array(id) }),
  z.object({
    type: z.literal("error"),
    code: ErrorCode,
    message: z.string(),
    /** The clientMsgId or channelId the error relates to, when there is one. */
    ref: z.string().optional(),
  }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** WebSocket close codes in the 4000s, which applications are free to define. */
export const CloseCode = {
  /** The client fell too far behind; reconnect and sync from the last seq it saw. */
  RESYNC: 4008,
  UNAUTHORIZED: 4401,
} as const;
