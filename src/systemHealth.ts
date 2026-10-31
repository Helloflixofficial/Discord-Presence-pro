import os from "node:os";
import { exec } from "node:child_process";
import util from "node:util";

const execPromise = util.promisify(exec);

export const BAR_STYLES: Record<string, { fill: string; empty: string; wrap: [string, string] }> = {
  capsule: { fill: "▰", empty: "▱", wrap: ["", ""] },
  shade: { fill: "█", empty: "░", wrap: ["", ""] },
  medium: { fill: "█", empty: "▒", wrap: ["", ""] },
  square: { fill: "■", empty: "□", wrap: ["", ""] },
  circle: { fill: "●", empty: "○", wrap: ["", ""] },
  diamond: { fill: "◆", empty: "◇", wrap: ["", ""] },
  cyberpunk: { fill: "█", empty: "░", wrap: ["[", "]"] },
  line: { fill: "━", empty: "┈", wrap: ["", ""] },
  braille: { fill: "⣿", empty: "⣀", wrap: ["", ""] },
  ascii: { fill: "=", empty: " ", wrap: ["[", "]"] }
};

export function renderBar(percentage: number, styleKey = "capsule", length = 10): string {
  const s = BAR_STYLES[styleKey] || BAR_STYLES.capsule;
  const filled = Math.min(length, Math.max(0, Math.round((percentage / 100) * length)));
  const empty = length - filled;
  return s.wrap[0] + s.fill.repeat(filled) + s.empty.repeat(empty) + s.wrap[1];
}

export interface GpuStats {
  name: string;
  shortName: string;
  utilization: number;
  usedGb: string;
  totalGb: string;
  bar: string;
  formatted: string;
}

export interface SystemHealth {
  ram: {
    totalGb: string;
    usedGb: string;
    freeGb: string;
    percentage: number;
    bar: string;
    formatted: string;
  };
  cpu: {
    model: string;
    cleanModel: string;
    cores: number;
    usagePercent: number;
    bar: string;
    formatted: string;
  };
  gpu?: GpuStats;
  host: {
    hostname: string;
    platform: string;
    arch: string;
    uptimeFormatted: string;
    uptimeSeconds: number;
  };
  process: {
    uptimeFormatted: string;
    rssMb: number;
    heapUsedMb: number;
    nodeVersion: string;
  };
}

let lastCpuPercent = 0;
let lastCpuCheckTime = 0;
let rawGpuData: { name: string; pct: number; usedGb: string; totalGb: string; shortName: string } | null = null;
let lastGpuCheckTime = 0;

function formatDuration(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ") || "< 1m";
}

function calculateCpuUsage(sampleMs = 120): Promise<number> {
  const startCpus = os.cpus();
  return new Promise((resolve) => {
    setTimeout(() => {
      const endCpus = os.cpus();
      let idleDiff = 0;
      let totalDiff = 0;
      for (let i = 0; i < startCpus.length; i++) {
        const s = startCpus[i].times;
        const e = endCpus[i].times;
        const idle = e.idle - s.idle;
        const total =
          e.user - s.user +
          (e.nice - s.nice) +
          (e.sys - s.sys) +
          (e.irq - s.irq) +
          idle;
        idleDiff += idle;
        totalDiff += total;
      }
      const pct = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
      lastCpuPercent = Math.max(0, Math.min(100, pct));
      lastCpuCheckTime = Date.now();
      resolve(lastCpuPercent);
    }, sampleMs);
  });
}

async function checkGpuRaw(): Promise<void> {
  if (Date.now() - lastGpuCheckTime < 4000 && rawGpuData !== null) {
    return;
  }
  try {
    const { stdout } = await execPromise(
      "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits"
    );
    const line = stdout.trim().split("\n")[0];
    if (line) {
      const parts = line.split(",").map((s) => s.trim());
      const name = parts[0] || "NVIDIA GPU";
      const pct = parseInt(parts[1], 10) || 0;
      const memUsed = parts[2] || "0";
      const memTotal = parts[3] || "4096";
      const shortName = name
        .replace(/NVIDIA GeForce\s*/i, "")
        .replace(/Laptop GPU/i, "")
        .trim();
      const usedGb = (parseInt(memUsed, 10) / 1024).toFixed(1);
      const totalGb = (parseInt(memTotal, 10) / 1024).toFixed(1);

      rawGpuData = {
        name,
        shortName: shortName || name,
        pct,
        usedGb,
        totalGb
      };
      lastGpuCheckTime = Date.now();
      return;
    }
  } catch {
    if (!rawGpuData) {
      rawGpuData = {
        name: "Dedicated GPU",
        shortName: "GPU",
        pct: 0,
        usedGb: "0.0",
        totalGb: "4.0"
      };
    }
  }
}

export function getSystemHealthSync(barStyle = "capsule"): SystemHealth {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);

  const totalGb = (total / 1024 ** 3).toFixed(1);
  const usedGb = (used / 1024 ** 3).toFixed(1);
  const freeGb = (free / 1024 ** 3).toFixed(1);
  const percentage = Math.round((used / total) * 100);

  const ramBar = renderBar(percentage, barStyle);
  const ramFormatted = `${ramBar} ${percentage}% · RAM ${usedGb}/${totalGb} GB`;

  const cpus = os.cpus();
  const rawCpuModel = cpus[0]?.model || "Multi-Core CPU";
  const cleanCpuModel = rawCpuModel
    .replace(/with Radeon Graphics.*/i, "")
    .replace(/Processor.*/i, "")
    .replace(/\(R\)/g, "")
    .replace(/\(TM\)/g, "")
    .replace(/CPU @.*/, "")
    .trim();

  const cpuBar = renderBar(lastCpuPercent, barStyle);
  const cpuFormatted = `${cpuBar} ${lastCpuPercent}% · CPU ${cleanCpuModel}`;

  let gpuStats: GpuStats | undefined = undefined;
  if (rawGpuData) {
    const gpuBar = renderBar(rawGpuData.pct, barStyle);
    gpuStats = {
      name: rawGpuData.name,
      shortName: rawGpuData.shortName,
      utilization: rawGpuData.pct,
      usedGb: rawGpuData.usedGb,
      totalGb: rawGpuData.totalGb,
      bar: gpuBar,
      formatted: `${gpuBar} ${rawGpuData.pct}% · GPU ${rawGpuData.shortName}`
    };
  }

  const memUsage = process.memoryUsage();

  return {
    ram: {
      totalGb,
      usedGb,
      freeGb,
      percentage,
      bar: ramBar,
      formatted: ramFormatted
    },
    cpu: {
      model: rawCpuModel.trim(),
      cleanModel: cleanCpuModel,
      cores: cpus.length,
      usagePercent: lastCpuPercent,
      bar: cpuBar,
      formatted: cpuFormatted
    },
    gpu: gpuStats,
    host: {
      hostname: os.hostname(),
      platform: `${os.type()} (${os.arch()})`,
      arch: os.arch(),
      uptimeFormatted: formatDuration(os.uptime()),
      uptimeSeconds: Math.floor(os.uptime())
    },
    process: {
      uptimeFormatted: formatDuration(process.uptime()),
      rssMb: Math.round(memUsage.rss / (1024 * 1024)),
      heapUsedMb: Math.round(memUsage.heapUsed / (1024 * 1024)),
      nodeVersion: process.version
    }
  };
}

export async function getSystemHealth(barStyle = "capsule"): Promise<SystemHealth> {
  const promises: Promise<unknown>[] = [checkGpuRaw()];
  if (Date.now() - lastCpuCheckTime > 2000) {
    promises.push(calculateCpuUsage(100));
  }
  await Promise.all(promises);
  return getSystemHealthSync(barStyle);
}

/**
 * Replaces template variables in details/state with live values using the chosen bar style:
 */
export function interpolatePlaceholders(text: string, barStyle = "capsule"): string {
  if (!text || !text.includes("{")) return text;
  const stats = getSystemHealthSync(barStyle);
  const gpuText = stats.gpu?.formatted || "GPU Active";
  return text
    .replace(/{cpu}/gi, stats.cpu.formatted)
    .replace(/{cpu_bar}/gi, stats.cpu.bar)
    .replace(/{cpu_pct}/gi, `${stats.cpu.usagePercent}%`)
    .replace(/{cpu_model}/gi, stats.cpu.cleanModel)
    .replace(/{gpu}/gi, gpuText)
    .replace(/{gpu_bar}/gi, stats.gpu?.bar || "")
    .replace(/{gpu_pct}/gi, `${stats.gpu?.utilization || 0}%`)
    .replace(/{gpu_name}/gi, stats.gpu?.shortName || "GPU")
    .replace(/{ram}/gi, stats.ram.formatted)
    .replace(/{ram_bar}/gi, stats.ram.bar)
    .replace(/{ram_pct}/gi, `${stats.ram.percentage}%`)
    .replace(/{ram_used}/gi, `${stats.ram.usedGb} GB`)
    .replace(/{ram_total}/gi, `${stats.ram.totalGb} GB`)
    .replace(/{server_health}/gi, stats.ram.formatted)
    .replace(/{hostname}/gi, stats.host.hostname)
    .replace(/{uptime}/gi, stats.host.uptimeFormatted)
    .replace(/{cpu_cores}/gi, `${stats.cpu.cores} Cores`);
}
