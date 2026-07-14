/**
 * pm2 process definition for the API + WebSocket relay.
 *
 * Why pm2 and not a container: this box is a 908MB EC2 instance already running another production
 * app. A container runtime is a second process supervisor, a second network stack, and a few hundred
 * megabytes of resident memory, in exchange for isolation we are not using. pm2 is what already
 * supervises the neighbour, so there is one supervisor, one convention, one `pm2 list` that tells the
 * truth about everything on the machine.
 *
 * `fork` mode with a single instance, deliberately — NOT `cluster`.
 *
 * Cluster mode would fork N workers behind a shared socket, and the WebSocket relay keeps its rooms in
 * process memory. Two workers means two disjoint sets of rooms: Alice connects to worker 1, Bob to
 * worker 2, and they never see each other's operations over the socket. It would look like it worked —
 * HTTP sync would still deliver everything, just slower — which is the most expensive kind of broken.
 * Going multi-instance requires the Postgres LISTEN/NOTIFY fanout described in ARCHITECTURE.md §13;
 * until that exists, one process is the correct number.
 */
module.exports = {
  apps: [
    {
      name: "vellum-backend",
      script: "dist/main.js",
      cwd: "/home/ubuntu/vellum-backend",
      exec_mode: "fork",
      instances: 1,

      // The .env is read by the app itself (config/env.ts). pm2 only needs to know it is production.
      env: {
        NODE_ENV: "production",
      },

      // 908MB box, shared with a neighbour that must not be OOM-killed because of us. If the API ever
      // climbs past 350MB it has a leak, and restarting it is strictly better than letting the kernel
      // choose a victim — the kernel does not know which process matters.
      max_memory_restart: "350M",

      // Restart on crash, but stop flapping: a process that cannot start (bad DATABASE_URL, port taken)
      // should fail visibly in `pm2 list` rather than burn the CPU of a 2-vCPU box forever.
      autorestart: true,
      max_restarts: 10,
      min_uptime: "20s",
      restart_delay: 2000,

      // SIGTERM → Fastify closes the HTTP server and every WebSocket. Give it time to drain rather than
      // cutting live sockets mid-frame on every deploy.
      kill_timeout: 10_000,

      merge_logs: true,
      time: true,
      out_file: "/home/ubuntu/.pm2/logs/vellum-backend-out.log",
      error_file: "/home/ubuntu/.pm2/logs/vellum-backend-error.log",
    },
  ],
};
