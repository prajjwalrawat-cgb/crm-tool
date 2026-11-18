import { Bone } from './_components/ui';

/** Skeletons, not spinners: mirrors the KPI strip + cards. */
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading report">
      <div className="flex items-end justify-between">
        <div className="space-y-1.5">
          <Bone className="h-4 w-40" />
          <Bone className="h-3 w-72" />
        </div>
        <Bone className="h-8 w-64" />
      </div>
      <Bone className="h-28 w-full" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Bone key={i} className="h-28" />
        ))}
      </div>
      <Bone className="h-64 w-full" />
    </div>
  );
}
