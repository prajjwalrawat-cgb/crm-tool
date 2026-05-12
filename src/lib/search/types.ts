/**
 * Wire shape for /api/search. Lives in its own file (no server imports)
 * so client components can `import type` from here without dragging the
 * route handler — which transitively imports `node:async_hooks` via
 * observability — into the browser bundle.
 */

export type SearchHit =
  | {
      kind: 'deal';
      id: string;
      title: string;
      subtitle: string | null;
      stage: string;
      href: string;
    }
  | {
      kind: 'company';
      id: string;
      title: string;
      subtitle: string | null;
      href: string;
    }
  | {
      kind: 'contact';
      id: string;
      title: string;
      subtitle: string | null;
      href: string;
    }
  | {
      kind: 'workflow';
      id: string;
      title: string;
      subtitle: string | null;
      status: string;
      href: string;
    }
  | {
      kind: 'task';
      id: string;
      title: string;
      subtitle: string | null;
      status: string;
      priority: string;
      href: string;
    };

export type SearchResponse = {
  query: string;
  hits: SearchHit[];
};
