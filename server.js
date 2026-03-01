import "dotenv/config";
import express from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Streamable HTTP transport는 SDK 버전에 따라 경로가 다를 수 있어 try/catch로 방어
let StreamableHTTPServerTransport = null;
try {
  // 일부 버전
  ({ StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js"));
} catch {
  try {
    // 다른 버전 가능성
    ({ StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamable-http.js"));
  } catch {
    // 없으면 SSE만으로 동작
    StreamableHTTPServerTransport = null;
  }
}

const app = express();

/**
 * ✅ /messages는 JSON-RPC가 들어오므로 JSON 파싱 필요.
 * 다만 어떤 환경에서는 content-type이 애매할 수 있어 raw도 보조로 둔다.
 */
app.use(express.json({ type: ["application/json", "application/*+json", "text/plain"] }));

const port = Number(process.env.PORT || 3000);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || "me";

/**
 * ✅ SSE 세션들 (여러 개 동시 허용)
 * sid -> { transport, res, keepAliveTimer, createdAt }
 */
const sseSessions = new Map();

/**
 * ✅ 최근 접속 sid (fallback 라우팅)
 */
let lastSseSid = null;

/** 공통 MCP 서버 생성(툴 정의) */
function buildMcpServer() {
  const server = new McpServer({
    name: "gym-routine-server",
    version: "0.1.0",
  });

  // get_today_routine
  server.tool(
    "get_today_routine",
    "오늘 운동 루틴과 운동 목록을 반환합니다.",
    { user_id: z.string().optional() },
    async ({ user_id }) => {
      const uid = user_id ?? DEFAULT_USER_ID;

      const { data: routine, error } = await supabase
        .from("routines")
        .select("*")
        .eq("user_id", uid)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return { content: [{ type: "text", text: `DB 오류: ${error.message}` }] };
      }

      if (!routine) {
        const { data: created, error: createErr } = await supabase
          .from("routines")
          .insert({ user_id: uid, name: "기본 전신 루틴", day_type: "fullbody" })
          .select("*")
          .single();

        if (createErr) {
          return { content: [{ type: "text", text: `루틴 생성 실패: ${createErr.message}` }] };
        }

        return {
          content: [{
            type: "json",
            json: {
              routine_id: created.id,
              routine_name: created.name,
              day_type: created.day_type,
              exercises: [
                { name: "스쿼트", target_sets: 3, target_reps: 8 },
                { name: "벤치프레스", target_sets: 3, target_reps: 8 },
                { name: "랫풀다운", target_sets: 3, target_reps: 10 },
              ],
              note: "초기 루틴이 없어 기본 루틴을 자동 생성했어요.",
            },
          }],
        };
      }

      return {
        content: [{
          type: "json",
          json: {
            routine_id: routine.id,
            routine_name: routine.name,
            day_type: routine.day_type,
            exercises: [
              { name: "스쿼트", target_sets: 3, target_reps: 8 },
              { name: "벤치프레스", target_sets: 3, target_reps: 8 },
              { name: "랫풀다운", target_sets: 3, target_reps: 10 },
            ],
          },
        }],
      };
    }
  );

  // log_workout
  server.tool(
    "log_workout",
    "운동 기록을 저장합니다.",
    {
      user_id: z.string().optional(),
      routine_id: z.string().uuid(),
      note: z.string().optional(),
      exercises: z.array(z.object({
        name: z.string(),
        weight: z.number().optional(),
        reps: z.number().int().optional(),
        sets: z.number().int().optional(),
      })),
    },
    async ({ user_id, routine_id, note, exercises }) => {
      const uid = user_id ?? DEFAULT_USER_ID;

      const { data: session, error: sessionErr } = await supabase
        .from("workout_sessions")
        .insert({ user_id: uid, routine_id, note: note ?? null })
        .select("*")
        .single();

      if (sessionErr) {
        return { content: [{ type: "text", text: `세션 저장 실패: ${sessionErr.message}` }] };
      }

      const rows = exercises.map((e) => ({
        session_id: session.id,
        exercise_name: e.name,
        weight: e.weight ?? null,
        reps: e.reps ?? null,
        sets: e.sets ?? null,
      }));

      const { error: setsErr } = await supabase.from("workout_sets").insert(rows);
      if (setsErr) {
        return { content: [{ type: "text", text: `세트 저장 실패: ${setsErr.message}` }] };
      }

      return {
        content: [{
          type: "json",
          json: { status: "saved", session_id: session.id, saved_count: rows.length },
        }],
      };
    }
  );

  // get_last_session
  server.tool(
    "get_last_session",
    "특정 운동의 최근 기록을 조회합니다.",
    { user_id: z.string().optional(), exercise_name: z.string() },
    async ({ exercise_name }) => {
      const { data: setRow, error } = await supabase
        .from("workout_sets")
        .select("session_id, exercise_name, weight, reps, sets, created_at")
        .eq("exercise_name", exercise_name)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return { content: [{ type: "text", text: `조회 실패: ${error.message}` }] };
      }

      if (!setRow) {
        return { content: [{ type: "json", json: { found: false, message: "최근 기록이 없습니다." } }] };
      }

      const { data: session, error: sErr } = await supabase
        .from("workout_sessions")
        .select("performed_at")
        .eq("id", setRow.session_id)
        .maybeSingle();

      if (sErr) {
        return { content: [{ type: "text", text: `세션 조회 실패: ${sErr.message}` }] };
      }

      return {
        content: [{
          type: "json",
          json: {
            found: true,
            exercise_name: setRow.exercise_name,
            last_weight: setRow.weight,
            last_reps: setRow.reps,
            last_sets: setRow.sets,
            last_date: session?.performed_at ?? setRow.created_at,
          },
        }],
      };
    }
  );

  return server;
}

/** 유틸: 세션 정리 */
async function cleanupSseSession(sid, reason) {
  const s = sseSessions.get(sid);
  if (!s) return;
  sseSessions.delete(sid);

  try { clearInterval(s.keepAliveTimer); } catch {}
  try { await s.transport.close?.(); } catch {}
  try { if (s.res && !s.res.writableEnded) s.res.end(); } catch {}

  console.log("[MCP] SSE session cleaned", { sid, reason, remain: sseSessions.size });
}

/** (중요) root도 200으로 열어둬서 검증 과정에서 괜히 실패하지 않게 */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "gym-routine-server",
    endpoints: { health: "/health", sse: "/sse", messages: "/messages", mcp: "/mcp" },
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * ✅ SSE endpoint (ChatGPT UI가 /sse 예시일 때)
 * - 절대 기존 연결을 임의로 죽이지 않음
 * - headersSent 문제 방지: setHeader/flushHeaders/res.write를 transport 생성 전에 하지 않음
 */
app.get("/sse", async (req, res) => {
  console.log("[HTTP] GET /sse");

  try {
    const transport = new SSEServerTransport("/messages", res);
    const server = buildMcpServer();

    await server.connect(transport);

    // sid 확보 (없으면 fallback 생성)
    const sid = String(transport.sessionId ?? `${Date.now()}_${Math.random()}`);
    lastSseSid = sid;

    // keepalive (프록시 유휴 끊김 방지)
    const keepAliveTimer = setInterval(() => {
      try { if (!res.writableEnded) res.write(":ping\n\n"); } catch {}
    }, 8000);

    sseSessions.set(sid, { transport, res, keepAliveTimer, createdAt: Date.now() });

    // 연결 종료 처리
    req.on("close", () => {
      void cleanupSseSession(sid, "client closed");
    });

    // (선택) connect 이후에만 write
    try { res.write(":connected\n\n"); } catch {}

    console.log("[MCP] SSE connected", { sid, sessions: sseSessions.size });
  } catch (err) {
    console.error("[MCP] SSE connect error:", err?.message ?? err);

    // headersSent면 더 쓰지 말고 종료
    try {
      if (!res.headersSent) {
        res.status(500).type("text").send(`SSE connect error: ${err?.message ?? String(err)}`);
      } else {
        if (!res.writableEnded) res.end();
      }
    } catch {}
  }
});

/**
 * ✅ SSE 메시지 endpoint
 * - /messages가 안 찍히는 문제를 잡기 위해 “무조건 로그 남김”
 * - sessionId 헤더가 없거나 매칭 실패하면 lastSseSid로 fallback
 * - 없으면 503 + Retry-After로 재시도 유도
 */
app.post("/messages", async (req, res) => {
  const querySidRaw = req.query?.sessionId;
  const querySid = Array.isArray(querySidRaw) ? querySidRaw[0] : querySidRaw;

  const sidHeaderRaw = req.headers["mcp-session-id"];
  const sidHeader = Array.isArray(sidHeaderRaw) ? sidHeaderRaw[0] : sidHeaderRaw;

  const bodySidRaw =
    req.body && typeof req.body === "object"
      ? (req.body.sessionId ?? req.body.session_id)
      : null;

  // SSE(legacy) = query.sessionId, Streamable HTTP = mcp-session-id header
  const sid =
    querySid != null ? String(querySid) :
    sidHeader != null ? String(sidHeader) :
    bodySidRaw != null ? String(bodySidRaw) :
    null;

  console.log("[HTTP] POST /messages", {
    querySid: querySid ?? null,
    headerSid: sidHeader ?? null,
    bodySid: bodySidRaw ?? null,
    resolvedSid: sid,
    sid,
    sessions: sseSessions.size,
    lastSseSid,
  });

  try {
    // 1) Explicit sid routing first. If provided but unknown, do not fallback.
    if (sid) {
      if (sseSessions.has(sid)) {
        return await sseSessions.get(sid).transport.handlePostMessage(req, res, req.body);
      }

      res.setHeader("Retry-After", "1");
      return res.status(404).json({
        error: "Session not found for provided sid.",
        got_sid: sid,
        known: Array.from(sseSessions.keys()),
      });
    }

    // 2) Fallback only when sid is completely missing.
    if (lastSseSid && sseSessions.has(lastSseSid)) {
      return await sseSessions.get(lastSseSid).transport.handlePostMessage(req, res, req.body);
    }

    // 3) Nothing active: ask client to retry after opening /sse
    res.setHeader("Retry-After", "1");
    return res.status(503).json({
      error: "No active SSE session. Call /sse first or retry.",
      got_sid: sid,
      known: Array.from(sseSessions.keys()),
    });
  } catch (err) {
    console.error("[MCP] /messages error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * ✅ Streamable HTTP endpoint (요즘 검증이 이쪽으로 올 때가 있음)
 * - SDK가 제공하는 경우에만 활성화
 */
app.all("/mcp", async (req, res) => {
  if (!StreamableHTTPServerTransport) {
    res.status(404).json({
      error: "StreamableHTTPServerTransport not available in this SDK version.",
      hint: "Use /sse instead.",
    });
    return;
  }

  console.log("[HTTP] ", req.method, "/mcp");

  try {
    const transport = new StreamableHTTPServerTransport(req, res);
    const server = buildMcpServer();
    await server.connect(transport);
  } catch (err) {
    console.error("[MCP] /mcp error:", err?.message ?? err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message ?? String(err) });
    } else {
      try { res.end(); } catch {}
    }
  }
});

app.listen(port, () => {
  console.log(`Gym MCP server listening on http://localhost:${port}`);
  console.log(`Endpoints: /health, /sse, /messages, /mcp`);
});