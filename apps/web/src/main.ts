interface AgentJob {
  id: string;
  task: string;
  status: string;
  result?: string;
  error?: string;
  steps: Array<{
    index: number;
    thought: string;
    observation?: string;
  }>;
}

const apiBase = "http://127.0.0.1:8080";
const form = document.querySelector<HTMLFormElement>("#job-form");
const taskInput = document.querySelector<HTMLTextAreaElement>("#task");
const jobsEl = document.querySelector<HTMLDivElement>("#jobs");
const detailEl = document.querySelector<HTMLPreElement>("#detail");
const statusEl = document.querySelector<HTMLSpanElement>("#status");
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh");

async function createJob(task: string): Promise<AgentJob> {
  const response = await fetch(`${apiBase}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task })
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const payload = (await response.json()) as { job: AgentJob };
  return payload.job;
}

async function loadJobs(): Promise<AgentJob[]> {
  const response = await fetch(`${apiBase}/jobs`);
  const payload = (await response.json()) as { jobs: AgentJob[] };
  return payload.jobs;
}

async function loadJob(jobId: string): Promise<AgentJob> {
  const response = await fetch(`${apiBase}/jobs/${jobId}`);
  const payload = (await response.json()) as { job: AgentJob };
  return payload.job;
}

function renderJobs(jobs: AgentJob[]): void {
  if (!jobsEl) {
    return;
  }
  jobsEl.innerHTML = "";
  for (const job of jobs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-row";
    button.innerHTML = `<span>${job.task}</span><strong>${job.status}</strong>`;
    button.addEventListener("click", () => {
      void showJob(job.id);
    });
    jobsEl.append(button);
  }
}

function renderDetail(job: AgentJob): void {
  if (statusEl) {
    statusEl.textContent = job.status;
    statusEl.dataset.status = job.status;
  }
  if (!detailEl) {
    return;
  }
  detailEl.textContent = JSON.stringify(
    {
      id: job.id,
      task: job.task,
      status: job.status,
      steps: job.steps,
      result: job.result,
      error: job.error
    },
    null,
    2
  );
}

async function showJob(jobId: string): Promise<void> {
  renderDetail(await loadJob(jobId));
}

async function refresh(): Promise<void> {
  renderJobs(await loadJobs());
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = taskInput?.value.trim();
  if (!task) {
    return;
  }
  const job = await createJob(task);
  renderDetail(job);
  await refresh();
});

refreshButton?.addEventListener("click", () => {
  void refresh();
});

void refresh();
