// The wire types this app uses, named, from the global `OpenFlow` namespace that
// `@openflow/protocol/global.d.ts` declares (included by tsconfig).
//
// The two runtime constants are mirrored here rather than imported: the package
// at the pinned commit exports them from a compiled `dist/` that a git install
// does not build (it has `prepack` but no `prepare`), so `import { WS_PATH }`
// would not resolve at runtime. Same values as `protocol/index.ts`.

export type Snapshot = OpenFlow.Snapshot;
export type Track = OpenFlow.Track;
export type ChainDevice = OpenFlow.ChainDevice;
export type ChainWatch = OpenFlow.ChainWatch;
export type WatchedChain = OpenFlow.WatchedChain;
export type DeviceParameterState = OpenFlow.DeviceParameterState;
export type DeviceTarget = OpenFlow.DeviceTarget;
export type DeviceRun = OpenFlow.DeviceRun;
export type DevicePatch = OpenFlow.DevicePatch;
export type ProbeReport = OpenFlow.ProbeReport;
export type ProbeBand = OpenFlow.ProbeBand;
export type ProbeEntry = OpenFlow.ProbeEntry;
export type Request = OpenFlow.Request;
export type Event = OpenFlow.Event;
export type EventType = OpenFlow.EventType;
export type EventOf<K extends EventType> = OpenFlow.EventOf<K>;

/** WebSocket path on the bridge. Mirrors `WS_PATH` in `@openflow/protocol`. */
export const WS_PATH = '/ws';
/** The bridge's port. Mirrors `DEFAULT_PORT` in `@openflow/protocol`. */
export const DEFAULT_PORT = 17800;
