/**
 * Local SlotMap augmentation for the agent-bus client build.
 *
 * The `shell.overlay` frame slot is declared at runtime by the ui-layout app
 * frame; it becomes a valid `ctx.slots.register` target only when that
 * package's type augmentation is part of the program. This standalone plugin
 * does not depend on ui-layout, so this augmentation declares the key with the
 * exact spec the frame uses, letting the workbench mount there under both the
 * browser web GUI and the Electron desktop shell.
 *
 * Type-only: it has no runtime effect; the live declaration is owned by the
 * frame, and `slots.inject` still waits on that real declaration before
 * registering.
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}
