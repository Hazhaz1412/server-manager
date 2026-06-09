import { timingSafeEqual } from "node:crypto";
import {
  DescribeInstancesCommand,
  EC2Client,
  RebootInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";

const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const INSTANCE_ID = requiredEnv("INSTANCE_ID");
const MINECRAFT_SERVICE =
  process.env.MINECRAFT_SERVICE?.trim() || "minecraft.service";
const MINECRAFT_PORT = Number(process.env.MINECRAFT_PORT || 25565);
const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION?.trim() || "Unknown";
const SERVER_ADDRESS = process.env.SERVER_ADDRESS?.trim() || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN?.trim() || "*";
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const STATUS_CACHE_TTL_MS =
  Math.max(0, Number(process.env.STATUS_CACHE_TTL || 15)) * 1000;

if (!/^[a-zA-Z0-9@_.-]+\.service$/.test(MINECRAFT_SERVICE)) {
  throw new Error("MINECRAFT_SERVICE must be a valid systemd service name.");
}

if (!Number.isInteger(MINECRAFT_PORT) || MINECRAFT_PORT < 1 || MINECRAFT_PORT > 65535) {
  throw new Error("MINECRAFT_PORT must be an integer from 1 to 65535.");
}

// Reused across warm invocations to reduce connection and initialization overhead.
const ec2 = new EC2Client({
  maxAttempts: 2,
});
const ssm = new SSMClient({
  maxAttempts: 2,
});

let statusCache = {
  expiresAt: 0,
  data: null,
};

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-control-token",
    "cache-control": "no-store",
  },
  body: statusCode === 204 ? "" : JSON.stringify(body),
});

const getMethod = (event) =>
  (
    event?.requestContext?.http?.method ||
    event?.httpMethod ||
    ""
  ).toUpperCase();

const getPath = (event) => {
  let path = event?.rawPath || event?.path || "/";
  const stage = event?.requestContext?.stage;

  if (stage && stage !== "$default" && path.startsWith(`/${stage}/`)) {
    path = path.slice(stage.length + 1);
  }

  return path.replace(/\/+$/, "") || "/";
};

const isAuthorized = (event) => {
  if (!CONTROL_TOKEN) return true;

  const headers = Object.fromEntries(
    Object.entries(event?.headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  const suppliedToken = headers["x-control-token"] || "";
  const expected = Buffer.from(CONTROL_TOKEN);
  const supplied = Buffer.from(suppliedToken);

  return (
    expected.length === supplied.length &&
    timingSafeEqual(expected, supplied)
  );
};

const invalidateStatusCache = () => {
  statusCache = {
    expiresAt: 0,
    data: null,
  };
};

const describeInstance = async () => {
  const result = await ec2.send(
    new DescribeInstancesCommand({
      InstanceIds: [INSTANCE_ID],
    }),
  );
  const instance = result.Reservations?.[0]?.Instances?.[0];

  if (!instance) {
    throw new Error(`Instance not found: ${INSTANCE_ID}`);
  }

  return instance;
};

const getInstanceStatus = async () => {
  const now = Date.now();
  if (statusCache.data && now < statusCache.expiresAt) {
    return {
      ...statusCache.data,
      cached: true,
    };
  }

  const instance = await describeInstance();
  const status = instance.State?.Name || "unknown";
  const publicIp = instance.PublicIpAddress || "";
  const publicDns = instance.PublicDnsName || "";
  const privateIp = instance.PrivateIpAddress || "";
  const address =
    SERVER_ADDRESS ||
    publicIp ||
    publicDns ||
    privateIp ||
    "";
  const launchTime = instance.LaunchTime?.getTime();
  const uptimeSeconds =
    status === "running" && launchTime
      ? Math.max(0, Math.floor((now - launchTime) / 1000))
      : 0;

  const data = {
    status,
    instanceId: INSTANCE_ID,
    address,
    publicIp,
    publicDns,
    privateIp,
    port: MINECRAFT_PORT,
    version: MINECRAFT_VERSION,
    uptimeSeconds,
    players: {
      online: "--",
      max: "--",
    },
    cached: false,
  };

  statusCache = {
    data,
    expiresAt: now + STATUS_CACHE_TTL_MS,
  };
  return data;
};

const startInstance = async () => {
  const result = await ec2.send(
    new StartInstancesCommand({
      InstanceIds: [INSTANCE_ID],
    }),
  );
  invalidateStatusCache();

  return {
    message: "Đã gửi yêu cầu bật EC2.",
    status: result.StartingInstances?.[0]?.CurrentState?.Name || "pending",
  };
};

const stopInstance = async () => {
  const result = await ec2.send(
    new StopInstancesCommand({
      InstanceIds: [INSTANCE_ID],
    }),
  );
  invalidateStatusCache();

  return {
    message: "Đã gửi yêu cầu tắt EC2.",
    status: result.StoppingInstances?.[0]?.CurrentState?.Name || "stopping",
  };
};

const requireRunningInstance = async (actionName) => {
  const instance = await describeInstance();
  const status = instance.State?.Name || "unknown";

  if (status !== "running") {
    return {
      error: jsonResponse(409, {
        message: `EC2 phải đang running để ${actionName} (hiện tại: ${status}).`,
      }),
    };
  }

  return { instance };
};

const restartInstance = async () => {
  const check = await requireRunningInstance("restart instance");
  if (check.error) return check.error;

  await ec2.send(
    new RebootInstancesCommand({
      InstanceIds: [INSTANCE_ID],
    }),
  );
  invalidateStatusCache();

  return {
    message: "Đã gửi yêu cầu restart EC2.",
    status: "rebooting",
  };
};

const restartMinecraft = async () => {
  const check = await requireRunningInstance("restart Minecraft");
  if (check.error) return check.error;

  const result = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [INSTANCE_ID],
      DocumentName: "AWS-RunShellScript",
      Parameters: {
        commands: [
          `systemctl restart ${MINECRAFT_SERVICE}`,
          `systemctl is-active ${MINECRAFT_SERVICE}`,
        ],
      },
      TimeoutSeconds: 120,
      Comment: "Restart Minecraft service from BlockOps",
    }),
  );
  invalidateStatusCache();

  return {
    message: "Đã gửi lệnh restart Minecraft qua SSM.",
    status: "restarting",
    commandId: result.Command?.CommandId,
  };
};

const routes = new Map([
  ["GET /status", getInstanceStatus],
  ["POST /start", startInstance],
  ["POST /stop", stopInstance],
  ["POST /restart-instance", restartInstance],
  ["POST /reboot", restartInstance],
  ["POST /restart-server", restartMinecraft],
]);

export const handler = async (event) => {
  const method = getMethod(event);
  const path = getPath(event);

  if (method === "OPTIONS") {
    return jsonResponse(204, {});
  }

  if (!isAuthorized(event)) {
    return jsonResponse(401, {
      message: "Access token không hợp lệ.",
    });
  }

  const route = routes.get(`${method} ${path}`);
  if (!route) {
    return jsonResponse(404, {
      message: `Không có route ${method} ${path}.`,
    });
  }

  try {
    const result = await route();
    if (result?.statusCode) return result;
    return jsonResponse(200, result);
  } catch (error) {
    const awsCode = error?.name || error?.Code || "INTERNAL_ERROR";
    const awsStatus = error?.$metadata?.httpStatusCode;

    console.error(
      JSON.stringify({
        code: awsCode,
        message: error?.message,
        requestId: error?.$metadata?.requestId,
      }),
    );

    return jsonResponse(awsStatus && awsStatus < 500 ? awsStatus : 502, {
      message: error?.message || "AWS request failed.",
      code: awsCode,
    });
  }
};
