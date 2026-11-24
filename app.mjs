const topicLabels = { delivery: "Доставка", pricing: "Стоимость", other: "Другое" };

export function createTriageController({ render, fetchImpl = fetch, timeoutMs = 5_000 }) {
  let latestRequest = 0;
  let activeController;

  async function submit(text) {
    const requestId = ++latestRequest;
    activeController?.abort();
    // Clear the old draft immediately, including on invalid input or transport errors.
    const empty = { topic: null, draft: "", loading: false };
    if (typeof text !== "string" || !text.trim()) {
      render({ ...empty, status: "invalid_input", message: "Введите текст заявки: одних пробелов недостаточно." });
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    render({ ...empty, status: "loading", loading: true, message: "Разбираем заявку…" });
    let timer;
    try {
      const data = await Promise.race([
        (async () => {
          const response = await fetchImpl("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: text.trim() }),
            signal: controller.signal,
          });
          const body = await response.json();
          if (response.status === 400 && body?.status === "invalid_input") return { status: "invalid_input" };
          if (!response.ok) throw new Error("API unavailable");
          return body;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("API deadline exceeded"));
          }, timeoutMs);
        }),
      ]);
      if (requestId !== latestRequest) return;
      if (data?.status === "invalid_input") {
        render({ ...empty, status: "invalid_input", message: "Введите непустой текст заявки." });
      } else if (data?.status === "ready" && Object.hasOwn(topicLabels, data.topic) &&
                 typeof data.draft === "string" && data.draft.trim()) {
        render({ status: "ready", topic: data.topic, draft: data.draft.trim(), loading: false,
          message: "Черновик готов. Проверьте его перед отправкой клиенту." });
      } else {
        render({ ...empty, status: "manual_review",
          message: "Нужен ручной разбор: AI не подготовил корректный ответ. Исходная заявка сохранена в поле выше. Напишите ответ вручную или повторите попытку." });
      }
    } catch {
      if (requestId !== latestRequest) return;
      render({ ...empty, status: "manual_review",
        message: "Нужен ручной разбор: сервис недоступен или не ответил вовремя. Исходная заявка сохранена в поле выше. Напишите ответ вручную или повторите попытку." });
    } finally {
      clearTimeout(timer);
      if (requestId === latestRequest) activeController = undefined;
    }
  }
  submit.reset = () => {
    ++latestRequest;
    activeController?.abort();
    activeController = undefined;
    render({ status: "idle", topic: null, draft: "", loading: false,
      message: "Текст изменён. Запустите разбор актуальной заявки." });
  };
  return submit;
}

if (typeof document !== "undefined") {
  const form = document.querySelector("form");
  const message = document.querySelector("#message");
  const feedback = document.querySelector("#feedback");
  const topic = document.querySelector("#topic");
  const draft = document.querySelector("#draft");
  const result = document.querySelector("#result");
  const submit = createTriageController({ render(state) {
    feedback.textContent = state.message;
    topic.textContent = state.topic ? topicLabels[state.topic] : "—";
    draft.value = state.draft;
    draft.readOnly = state.loading;
    result.dataset.status = state.status;
    result.setAttribute("aria-busy", String(state.loading));
    message.setAttribute("aria-invalid", String(state.status === "invalid_input"));
  } });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(message.value);
  });
  message.addEventListener("input", () => {
    // Editing invalidates in-flight work and clears any draft for the previous text.
    submit.reset();
  });
}
