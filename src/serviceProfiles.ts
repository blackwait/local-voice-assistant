export type ServiceProfile = "stable" | "fast";

export const SERVICE_PROFILE_STABLE: ServiceProfile = "stable";
export const SERVICE_PROFILE_FAST: ServiceProfile = "fast";

const STABLE_ENDPOINT = "http://10.254.81.32:10095";
const FAST_ENDPOINT = "http://10.254.10.76:10095";

export const SERVICE_PROFILE_OPTIONS: Array<{
  id: ServiceProfile;
  label: string;
  description: string;
}> = [
  {
    id: SERVICE_PROFILE_STABLE,
    label: "稳定",
    description: "默认线路，远端主服务器，适合日常使用"
  },
  {
    id: SERVICE_PROFILE_FAST,
    label: "快速",
    description: "笔记本本地服务器，延迟更低"
  }
];

export function normalizeServiceProfile(value: string | undefined | null): ServiceProfile {
  return value === SERVICE_PROFILE_FAST ? SERVICE_PROFILE_FAST : SERVICE_PROFILE_STABLE;
}

export function getServiceProfileEndpoints(profile: ServiceProfile) {
  const endpoint = profile === SERVICE_PROFILE_FAST ? FAST_ENDPOINT : STABLE_ENDPOINT;
  return {
    funasr_endpoint: endpoint,
    deepseek_endpoint: endpoint
  };
}

export function getServiceProfileLabel(profile: ServiceProfile) {
  return SERVICE_PROFILE_OPTIONS.find((option) => option.id === profile)?.label ?? "稳定";
}

export function inferServiceProfileFromEndpoint(endpoint: string | undefined | null): ServiceProfile {
  const normalized = (endpoint ?? "").trim().replace(/\/+$/, "");
  if (normalized === FAST_ENDPOINT) {
    return SERVICE_PROFILE_FAST;
  }
  return SERVICE_PROFILE_STABLE;
}
