import { Client } from "@notionhq/client";
import type {
  AutomationProject,
  NotionDatabaseInspection,
  NotionDatabaseSummary,
} from "@notion-tmux/shared";

export interface Ticket {
  pageId: string;
  ref: string;
  name: string;
  status: string | null;
  type: string | null;
  priority: string | null;
  area: string[];
  summary: string;
}

function plainText(rich: any[] | undefined): string {
  return Array.isArray(rich) ? rich.map((item) => item?.plain_text ?? "").join("") : "";
}

function statusName(property: any): string | null {
  return property?.status?.name ?? property?.select?.name ?? null;
}

export class NotionGateway {
  private readonly client: Client;

  constructor(token: string) {
    this.client = new Client({ auth: token });
  }

  async validate(): Promise<string> {
    const me: any = await this.client.users.me({});
    return me?.name ?? me?.bot?.owner?.type ?? "Connected";
  }

  async listDatabases(): Promise<NotionDatabaseSummary[]> {
    const databases: NotionDatabaseSummary[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.search({
        filter: { property: "object", value: "database" },
        start_cursor: cursor,
        page_size: 100,
      });
      for (const item of response.results ?? []) {
        databases.push({
          id: item.id,
          title: plainText(item.title) || "(untitled database)",
          url: item.url,
        });
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return databases.sort((a, b) => a.title.localeCompare(b.title));
  }

  async inspectDatabase(databaseId: string): Promise<NotionDatabaseInspection> {
    const database: any = await this.client.databases.retrieve({
      database_id: normalizeNotionId(databaseId),
    });
    return {
      id: database.id,
      title: plainText(database.title) || "(untitled database)",
      url: database.url,
      properties: Object.entries(database.properties ?? {}).map(([name, property]: [string, any]) => {
        const options =
          property?.status?.options ??
          property?.select?.options ??
          property?.multi_select?.options ??
          [];
        return {
          name,
          type: property?.type ?? "unknown",
          options: options.map((option: any) => option.name),
        };
      }),
    };
  }

  async queryTrigger(project: AutomationProject): Promise<Ticket[]> {
    const filterBase = { property: project.statusProperty };
    let response: any;
    try {
      response = await this.client.databases.query({
        database_id: normalizeNotionId(project.databaseId),
        filter: { ...filterBase, status: { equals: project.triggerStatus } } as any,
      });
    } catch {
      response = await this.client.databases.query({
        database_id: normalizeNotionId(project.databaseId),
        filter: { ...filterBase, select: { equals: project.triggerStatus } } as any,
      });
    }
    return response.results.map((page: any) => this.readTicket(page, project));
  }

  async getTicket(pageId: string, project: AutomationProject): Promise<Ticket> {
    const page = await this.client.pages.retrieve({ page_id: pageId });
    return this.readTicket(page as any, project);
  }

  async getTicketBody(pageId: string): Promise<string> {
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of response.results as any[]) {
        const text = plainText(block[block.type]?.rich_text);
        if (!text) continue;
        if (block.type.startsWith("heading_")) lines.push(`\n## ${text}`);
        else if (block.type === "bulleted_list_item" || block.type === "numbered_list_item") {
          lines.push(`- ${text}`);
        } else if (block.type === "to_do") {
          lines.push(`- [${block.to_do?.checked ? "x" : " "}] ${text}`);
        } else {
          lines.push(text);
        }
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return lines.join("\n").trim();
  }

  async setStatus(pageId: string, project: AutomationProject, status: string): Promise<void> {
    try {
      await this.client.pages.update({
        page_id: pageId,
        properties: { [project.statusProperty]: { status: { name: status } } } as any,
      });
    } catch {
      await this.client.pages.update({
        page_id: pageId,
        properties: { [project.statusProperty]: { select: { name: status } } } as any,
      });
    }
  }

  async setPrUrl(pageId: string, project: AutomationProject, url: string): Promise<void> {
    await this.client.pages.update({
      page_id: pageId,
      properties: { [project.prProperty]: { url } },
    });
  }

  async addComment(pageId: string, text: string): Promise<void> {
    await this.client.comments.create({
      parent: { page_id: pageId },
      rich_text: [{ type: "text", text: { content: text.slice(0, 1_900) } }],
    });
  }

  private readTicket(page: any, project: AutomationProject): Ticket {
    const properties = page.properties ?? {};
    const uniqueId = properties[project.ticketIdProperty]?.unique_id;
    const title = Object.values(properties).find((value: any) => value?.type === "title") as any;
    return {
      pageId: page.id,
      ref:
        uniqueId?.number != null
          ? `${uniqueId.prefix ?? ""}${uniqueId.number}`
          : page.id,
      name: plainText(title?.title) || "(untitled)",
      status: statusName(properties[project.statusProperty]),
      type: properties.Type?.select?.name ?? null,
      priority: properties.Priority?.select?.name ?? null,
      area: (properties.Area?.multi_select ?? []).map((option: any) => option.name),
      summary: plainText(properties.Summary?.rich_text),
    };
  }
}

export function normalizeNotionId(id: string): string {
  return id.replace(/-/g, "");
}

export function pageIdFromArg(input: string): string {
  const match = input.match(/([0-9a-f]{32})(?:\?|$)/i) ?? input.match(/([0-9a-f-]{36})/i);
  return match ? match[1] : input;
}
