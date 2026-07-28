import { Client } from "pg";

export type NotifyHandler = (channel: string, payload: string | undefined) => void;

export interface Listener {
  close(): Promise<void>;
}

/**
 * §4.9: LISTEN/NOTIFY for immediate wakeup, with polling as the fallback —
 * a dedicated long-lived connection is required since LISTEN is
 * connection-scoped and Pool hands out arbitrary connections per query.
 */
export async function createListener(
  connectionString: string,
  channels: string[],
  onNotify: NotifyHandler,
): Promise<Listener> {
  const client = new Client({ connectionString });
  await client.connect();
  for (const channel of channels) {
    await client.query(`LISTEN ${channel}`);
  }
  client.on("notification", (msg) => onNotify(msg.channel, msg.payload));
  client.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[listener] connection error (polling fallback keeps working):", err);
  });
  return {
    close: async () => {
      await client.end();
    },
  };
}
