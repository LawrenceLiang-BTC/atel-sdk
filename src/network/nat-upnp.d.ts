declare module 'nat-upnp' {
  interface PortMapping {
    public: number;
    private: number;
    ttl?: number;
    description?: string;
  }

  interface PortUnmapping {
    public: number;
  }

  interface Client {
    portMapping(opts: PortMapping, cb: (err: Error | null) => void): void;
    portUnmapping(opts: PortUnmapping, cb: (err: Error | null) => void): void;
    externalIp(cb: (err: Error | null, ip: string) => void): void;
    close(): void;
  }

  function createClient(): Client;
  export = { createClient };
}
