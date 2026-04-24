// monday-connect.js
// Vercel Serverless Function
// Place this file at: /api/monday-connect.js in your Vercel project
//
// HOW IT WORKS:
// 1. monday.com fires a webhook to this endpoint when a new invoice is created on Board A
// 2. The script reads the new item's name (the Intacct Code, e.g. "10292")
// 3. It searches Board B (Projects) for an item where "Intacct Code" column matches
// 4. It updates that project's "LINK TO: Invoice Request" column with the new invoice item ID

// ─── CONFIGURATION ─────────────────────────────────────────────────────────────
const MONDAY_API_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjYxODkxMzk0OCwiYWFpIjoxMSwidWlkIjo5NjMwNjEzOSwiaWFkIjoiMjAyNi0wMi0wOVQxNTo0MTo0Mi4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MTQzMjY4OTAsInJnbiI6InVzZTEifQ.exeQLAWLzziSBJR-ZGx9shxe1pwjH41RLTkhb9oZ1NQ"; // Profile → Developers → My Access Tokens
const BOARD_A_ID = "8193778717";       // Invoice Request / Payment Tracking
const BOARD_B_ID = "7696868656";       // Projects
const BOARD_B_INTACCT_COL = "intacct_code_mkmkcg26";   // "Intacct Code" text column on Projects
const BOARD_B_CONNECT_COL = "connect_boards_mkmnd2zg"; // "LINK TO: Invoice Request" column on Projects
// ───────────────────────────────────────────────────────────────────────────────

const MONDAY_API_URL = "https://api.monday.com/v2";

// Helper: run a GraphQL query against the monday.com API
async function mondayQuery(query, variables = {}) {
  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: MONDAY_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json();
  if (data.errors) {
    throw new Error(`monday.com API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

// Step 1: Get the name (Intacct Code) of the newly created invoice item
async function getInvoiceItemName(itemId) {
  const query = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        name
      }
    }
  `;
  const data = await mondayQuery(query, { itemId: [String(itemId)] });
  return data.items?.[0]?.name || null;
}

// Step 2: Search Board B (Projects) for an item where Intacct Code column matches
async function findProjectByIntacctCode(intacctCode) {
  const query = `
    query ($boardId: ID!, $columnId: String!, $columnValue: String!) {
      items_page_by_column_values(
        board_id: $boardId
        columns: [{ column_id: $columnId, column_values: [$columnValue] }]
        limit: 1
      ) {
        items {
          id
          name
          column_values(ids: ["${BOARD_B_CONNECT_COL}"]) {
            id
            value
          }
        }
      }
    }
  `;
  const data = await mondayQuery(query, {
    boardId: BOARD_B_ID,
    columnId: BOARD_B_INTACCT_COL,
    columnValue: intacctCode,
  });
  return data.items_page_by_column_values?.items?.[0] || null;
}

// Step 3: Update the "LINK TO: Invoice Request" column on the matched project
async function connectProjectToInvoice(projectItemId, invoiceItemId, existingValue) {
  // Parse existing linked item IDs so we don't overwrite them
  let existingIds = [];
  if (existingValue) {
    try {
      const parsed = JSON.parse(existingValue);
      existingIds = parsed.linkedPulseIds?.map((p) => p.linkedPulseId) || [];
    } catch {
      // ignore parse errors
    }
  }

  // Add the new invoice item ID if not already linked
  if (!existingIds.includes(Number(invoiceItemId))) {
    existingIds.push(Number(invoiceItemId));
  }

  const newValue = JSON.stringify({
    linkedPulseIds: existingIds.map((id) => ({ linkedPulseId: id })),
  });

  const mutation = `
    mutation ($itemId: ID!, $boardId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(
        item_id: $itemId
        board_id: $boardId
        column_id: $columnId
        value: $value
      ) {
        id
      }
    }
  `;
  await mondayQuery(mutation, {
    itemId: String(projectItemId),
    boardId: BOARD_B_ID,
    columnId: BOARD_B_CONNECT_COL,
    value: newValue,
  });
}

// ─── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body;

  // monday.com sends a challenge on first setup — respond to verify the webhook
  if (body?.challenge) {
    return res.status(200).json({ challenge: body.challenge });
  }

  try {
    const event = body?.event;
    if (!event) {
      return res.status(400).json({ error: "No event in payload" });
    }

    const invoiceItemId = event.pulseId;
    if (!invoiceItemId) {
      return res.status(400).json({ error: "No item ID in event" });
    }

    console.log(`New invoice item created: ${invoiceItemId}`);

    // Step 1: Get the invoice name (Intacct Code)
    const intacctCode = await getInvoiceItemName(invoiceItemId);
    if (!intacctCode) {
      console.log("Could not retrieve item name — skipping");
      return res.status(200).json({ status: "skipped", reason: "no item name" });
    }
    console.log(`Intacct Code: ${intacctCode}`);

    // Step 2: Find the matching project on Board B
    const project = await findProjectByIntacctCode(intacctCode);
    if (!project) {
      console.log(`No project found with Intacct Code: ${intacctCode}`);
      return res.status(200).json({ status: "skipped", reason: "no matching project" });
    }
    console.log(`Matched project: ${project.name} (ID: ${project.id})`);

    // Step 3: Update the project's connect column
    const existingValue = project.column_values?.[0]?.value || null;
    await connectProjectToInvoice(project.id, invoiceItemId, existingValue);

    console.log(`Successfully linked invoice ${invoiceItemId} to project ${project.id}`);
    return res.status(200).json({ status: "success", projectId: project.id, invoiceItemId });

  } catch (error) {
    console.error("Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}
