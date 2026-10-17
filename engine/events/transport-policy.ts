export type EventTransportPolicy = {
  pushEnabled: boolean;
  pollingEnabled: boolean;
};

export function eventTransportPolicy(env: NodeJS.ProcessEnv): EventTransportPolicy {
  return {
    pushEnabled: env.LINEY_DISABLE_PUSH !== "1",
    pollingEnabled: env.LINEY_DISABLE_EVENT_POLLING !== "1",
  };
}
