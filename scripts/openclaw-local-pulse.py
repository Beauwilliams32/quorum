#!/usr/bin/env python3
"""OpenClaw's local-model fleet pulse into Quorum's planning queue.

Quorum supplies bounded host/agent/job observations. OpenClaw summarizes them locally.
Only planning missions are created; dispatch, process signals, config writes and sends
stay behind Quorum's own preview/confirmation and owner approval boundaries.
"""
import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "http://127.0.0.1:4747"
MODEL = "ollama/gemma4:latest"
OLLAMA_BASE = "http://127.0.0.1:11435"
OWNED_SERVICE_PREFIXES = ("ai.hermes.", "ai.openclaw.", "com.tridentsocial.",
                          "com.williamsmedia.", "com.beauwilliams.")


def request(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as response:
        return json.load(response)


def diagnose():
    """Use Quorum's inventory; do not infer failure from idle vendor services."""
    health = request("/health")
    bridge = request("/api/openclaw/status")
    jobs = request("/api/standing-jobs")
    platform = request("/api/platform")
    doctor = request("/api/agent-control/doctor")
    findings = []
    if health.get("status") != "ok":
        findings.append(("quorum-health", "Quorum health is not ok"))
    if bridge.get("connectionState") != "connected":
        findings.append(("openclaw-bridge", "Quorum OpenClaw read bridge is " +
                         str(bridge.get("connectionState", "unknown"))[:30]))
    for job in jobs.get("jobs", []):
        if job.get("registered") and not job.get("suspended") and job.get("status") in ("attention", "failed", "degraded"):
            findings.append(("job-" + str(job.get("id", "unknown"))[:60],
                             "Quorum standing job " + str(job.get("id", "unknown"))[:60] +
                             " is " + str(job.get("status"))[:30]))
    for service in platform.get("services", []):
        label = str(service.get("id", "")).removeprefix("service:")
        if (label.startswith(OWNED_SERVICE_PREFIXES) and
                service.get("state") != "running" and
                service.get("exitCode") not in (None, 0)):
            findings.append(("service-" + label[:65],
                             "Owned service " + label[:65] + " is " +
                             str(service.get("state"))[:20] + " (nonzero last exit)"))
    for index, blocker in enumerate(doctor.get("blockers", [])[:5]):
        # Quorum's doctor gives short policy findings; exclude accidental secrets/paths.
        safe = str(blocker).replace("\n", " ")[:100]
        if any(token in safe.lower() for token in ("token", "password", "secret", "api key")):
            safe = "agent-control safety finding (details remain in Quorum doctor)"
        findings.append(("agent-policy-" + str(index), safe))
    return findings[:12]


def local_summary(findings):
    observations = "; ".join(text for _, text in findings)
    prompt = ("/no_think\nYou are a local diagnostic summarizer. Do not use tools. "
              "Return one concise sentence naming the highest-priority next read-only check. "
              "Do not claim a repair, authorize a daemon action, or mention credentials.\n" +
              "Observations: " + observations)
    # Headless --isolated ignores the configured provider, while ambient exec
    # fails on an unrelated gateway SecretRef in this release. Never use cloud.
    data = json.dumps({"model": MODEL.removeprefix("ollama/"), "prompt": prompt,
                       "stream": False, "options": {"num_predict": 512}}).encode()
    req = urllib.request.Request(OLLAMA_BASE + "/api/generate", data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as response:
        result = json.load(response)
    if not result.get("done") or not str(result.get("response", "")).strip():
        raise RuntimeError("local inference returned no final answer")
    return " ".join(result["response"].split())[:700]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    findings = diagnose()
    if not findings:
        print("healthy fleet: no mission")
        return 0
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    signature = hashlib.sha256("|".join(sorted(key for key, _ in findings)).encode()).hexdigest()[:10]
    title = "OpenClaw fleet pulse: " + day + " / " + signature
    if not args.dry_run:
        for mission in request("/api/missions").get("missions", []):
            if str(mission.get("title", "")).startswith("OpenClaw fleet pulse: " + day):
                print("existing mission: " + str(mission.get("id")))
                return 0
    summary = local_summary(findings)
    observations = "; ".join(text for _, text in findings)
    objective = ("Read-only host-wide diagnostic handoff from OpenClaw " + MODEL + ". "
                 "Observed: " + observations[:2600] + ". Local assessment: " + summary + " "
                 "Investigate in Quorum and preview each proposed task. Do not auto-dispatch, "
                 "restart daemons, edit profiles, deploy, publish, or send externally without approval.")
    if args.dry_run:
        print(json.dumps({"dry_run": True, "model": MODEL, "title": title,
                          "findings": findings, "assessment": summary}))
        return 0
    tasks = [{"id": "diagnose-" + hashlib.sha256(key.encode()).hexdigest()[:12],
              "title": "Investigate " + key[:90],
              "description": "Read-only verification: " + text +
                             ". Return evidence and a proposed remedy; no mutations or dispatch.",
              "status": "queued"} for key, text in findings]
    created = request("/api/missions", {"title": title, "objective": objective,
                                         "tasks": tasks})["mission"]
    mission = request("/api/missions/" + created["id"])["mission"]
    if mission.get("title") != title or len(mission.get("tasks", [])) != len(tasks):
        raise RuntimeError("Quorum mission readback did not match")
    print("created Quorum planning mission: " + created["id"] +
          " with " + str(len(tasks)) + " queued diagnostic tasks")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, urllib.error.URLError, RuntimeError) as exc:
        print("fleet pulse failed: " + type(exc).__name__ + ": " + str(exc)[:180], file=sys.stderr)
        sys.exit(1)
