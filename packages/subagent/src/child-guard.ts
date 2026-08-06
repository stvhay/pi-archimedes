import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  decodeLimitsEnvironment,
  registerChildLimitGuard,
  SUBAGENT_LIMITS_ENV,
} from "./limits.js";

export default function registerChildGuard(pi: ExtensionAPI): void {
  const encodedLimits = process.env[SUBAGENT_LIMITS_ENV];
  if (!encodedLimits) return;
  registerChildLimitGuard(pi, decodeLimitsEnvironment(encodedLimits));
}
