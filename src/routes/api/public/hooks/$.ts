import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/hooks/$")({ server: { handlers: {
  POST: async ({request}) => { const {getApi} = await import("@/adapters/runtime"); return getApi().fetch(request); },
} } });