const publicKey = process.env.VECTOR_NATS_JWT_SIGNER_PUBLIC_KEY;
if (!publicKey) {
  throw new Error(`VECTOR_NATS_JWT_SIGNER_PUBLIC_KEY is required`);
}

const privateKey = process.env.VECTOR_NATS_JWT_SIGNER_PRIVATE_KEY;
if (!publicKey) {
  throw new Error(`VECTOR_NATS_JWT_SIGNER_PRIVATE_KEY is required`);
}

const natsServers = process.env.VECTOR_NATS_SERVERS;
if (!natsServers) {
  throw new Error(`VECTOR_NATS_SERVERS is required`);
}

const adminToken = process.env.VECTOR_ADMIN_TOKEN;
if (!adminToken) {
  throw new Error(`VECTOR_ADMIN_TOKEN is required`);
}

export const config = {
  messagingUrl: natsServers,
  privateKey,
  publicKey,
  adminToken,
  port: parseInt(process.env.VECTOR_PORT ?? "5040"),
};
