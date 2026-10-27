declare module "discord-rpc" {
  const RPC: {
    Client: new (options: { transport: "ipc" }) => {
      login(options: { clientId: string }): Promise<void>;
      setActivity(activity: Record<string, unknown>): Promise<void>;
      destroy(): void;
    };
  };
  export default RPC;
}
