function doGet(e) {
  // --- 1) Validate params ---
  if (!e || !e.parameter) {
    return json_({ found: false, error: "No query parameters provided" });
  }

  const emailToFind = (e.parameter.email || "").toString().trim().toLowerCase();
  const serverId = (e.parameter.serverId || "").toString().trim();

  if (!emailToFind) {
    return json_({ found: false, error: "No email parameter provided" });
  }
  if (!serverId) {
    return json_({ found: false, error: "No serverId parameter provided" });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // V2 is opt-in per server. Legacy servers continue through the original code below.
  const v2Server = getV2Server_(ss, serverId);
  if (v2Server) {
    return json_(handleV2Lookup_(ss, emailToFind, serverId, v2Server));
  }

  // ---------------------------------------------------------------------------
  // LEGACY V1 LOOKUP
  // Keep this path behavior-compatible with the original API.
  // ---------------------------------------------------------------------------

  // --- 2) Open server-specific sheet by name (serverId) ---
  const serverSheet = ss.getSheetByName(serverId);
  if (!serverSheet) {
    return json_({
      found: false,
      error: `Server sheet not found: "${serverId}"`,
    });
  }

  const serverData = serverSheet.getDataRange().getValues();
  if (!serverData || serverData.length < 2) {
    return json_({
      found: false,
      error: `Server sheet "${serverId}" has no data rows`,
    });
  }

  // --- 3) Find user by email in server sheet (Col B) ---
  let foundRow = null;
  for (let i = 1; i < serverData.length; i++) { // skip header
    const row = serverData[i];
    if (!row || row.length < 2) continue;

    const sheetEmail = (row[1] || "").toString().trim().toLowerCase();
    if (sheetEmail === emailToFind) {
      foundRow = row;
      break;
    }
  }

  if (!foundRow) {
    return json_({
      found: false,
      message: "Email not found in database",
      serverId,
    });
  }

  const name = (foundRow[0] || "").toString().trim();
  const email = (foundRow[1] || "").toString().trim();
  const role = (foundRow[2] || "").toString().trim(); // role name like "TA"

  // --- 4) Open config and resolve roleId + prefix ---
  const configSheet = ss.getSheetByName("config");
  if (!configSheet) {
    return json_({
      found: true,
      name,
      email,
      role,
      roleId: null,
      nicknamePrefix: "",
      warning: 'Missing "config" sheet; returning without roleId/prefix',
    });
  }

  const configData = configSheet.getDataRange().getValues();
  let roleId = null;
  let nicknamePrefix = "";

  // Match: Col A = serverId, Col B = role
  for (let i = 1; i < configData.length; i++) {
    const row = configData[i];
    if (!row || row.length < 4) continue;

    const cfgServerId = (row[0] || "").toString().trim();
    const cfgRole = (row[1] || "").toString().trim();

    if (cfgServerId === serverId && cfgRole === role) {
      roleId = (row[2] || "").toString().trim() || null;
      nicknamePrefix = (row[3] || "").toString().trim(); // can be blank
      break;
    }
  }

  return json_({
    found: true,
    serverId,
    name,
    email,
    role,
    roleId,
    nicknamePrefix,
  });
}

function getV2Server_(ss, serverId) {
  const sheet = ss.getSheetByName("discord_servers");
  if (!sheet) return null;

  const table = readHeaderTable_(sheet);
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    const rowServerId = string_(row[table.columns["Server ID"]]);
    const schemaVersion = Number(row[table.columns["Schema Version"]] || 0);
    const active = bool_(row[table.columns["Active"]]);

    if (rowServerId === serverId && schemaVersion === 2 && active) {
      return {
        serverId: rowServerId,
        serverName: string_(row[table.columns["Server Name"]]),
        schemaVersion: 2,
        nicknameMode: string_(row[table.columns["Nickname Mode"]]) || "name_only",
      };
    }
  }

  return null;
}

function handleV2Lookup_(ss, emailToFind, serverId, serverConfig) {
  const entities = getActiveKeys_(ss, "discord_entities", serverId, "Entity Key");
  const positions = getActiveKeys_(ss, "discord_positions", serverId, "Position Key");

  if (!entities.size) {
    return {
      schemaVersion: 2,
      found: false,
      serverId,
      error: "No active entities configured for this v2 server",
    };
  }

  const personResult = resolveV2Person_(ss, emailToFind);
  if (personResult.blocked) {
    return {
      schemaVersion: 2,
      found: false,
      serverId,
      reason: "person_inactive",
      message: "This person is inactive in discord_people",
    };
  }

  const executiveResult = getExecutiveAssignments_(ss, emailToFind, entities, positions);
  if (executiveResult.error) {
    return {
      schemaVersion: 2,
      found: false,
      serverId,
      error: executiveResult.error,
    };
  }

  const manualResult = getManualAssignments_(ss, emailToFind, serverId, entities, positions);
  if (manualResult.error) {
    return {
      schemaVersion: 2,
      found: false,
      serverId,
      error: manualResult.error,
    };
  }

  const assignments = dedupeAssignments_(executiveResult.assignments.concat(manualResult.assignments));

  if (!assignments.length) {
    return {
      schemaVersion: 2,
      found: false,
      serverId,
      reason: "no_active_assignments",
      message: "Email has no active Discord assignments for this server",
    };
  }

  const fallbackExecPerson = executiveResult.person;
  const person = personResult.person || fallbackExecPerson;

  if (!person || !string_(person.name)) {
    return {
      schemaVersion: 2,
      found: false,
      serverId,
      reason: "identity_not_found",
      message: "Assignment found, but no person identity could be resolved",
    };
  }

  if (!person.campus && fallbackExecPerson && fallbackExecPerson.campus) {
    person.campus = fallbackExecPerson.campus;
  }
  if (!person.studentId && fallbackExecPerson && fallbackExecPerson.studentId) {
    person.studentId = fallbackExecPerson.studentId;
  }

  return {
    schemaVersion: 2,
    found: true,
    serverId,
    nicknameMode: serverConfig.nicknameMode,
    person: {
      email: emailToFind,
      name: string_(person.name),
      studentId: string_(person.studentId) || null,
      campus: string_(person.campus) || null,
    },
    assignments,
  };
}

function resolveV2Person_(ss, emailToFind) {
  const peopleSheet = ss.getSheetByName("discord_people");
  if (peopleSheet) {
    const table = readHeaderTable_(peopleSheet);
    const emailCol = table.columns["Email"];
    const activeCol = table.columns["Active"];

    if (emailCol !== undefined) {
      for (let i = 0; i < table.rows.length; i++) {
        const row = table.rows[i];
        if (normalizeEmail_(row[emailCol]) !== emailToFind) continue;

        if (activeCol !== undefined && !bool_(row[activeCol])) {
          return { blocked: true, person: null };
        }

        return {
          blocked: false,
          person: {
            email: emailToFind,
            name: valueByHeader_(row, table.columns, "Name"),
            studentId: valueByHeader_(row, table.columns, "Student ID"),
            campus: valueByHeader_(row, table.columns, "Campus"),
          },
        };
      }
    }
  }

  // students intentionally has no header: A = student ID, B = email, C = name.
  const studentsSheet = ss.getSheetByName("students");
  if (studentsSheet) {
    const data = studentsSheet.getDataRange().getValues();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (normalizeEmail_(row[1]) !== emailToFind) continue;
      return {
        blocked: false,
        person: {
          email: emailToFind,
          name: string_(row[2]),
          studentId: string_(row[0]),
          campus: "",
        },
      };
    }
  }

  return { blocked: false, person: null };
}

function getExecutiveAssignments_(ss, emailToFind, validEntities, validPositions) {
  const sheet = ss.getSheetByName("exec database");
  if (!sheet) return { assignments: [], person: null };

  const table = readHeaderTable_(sheet);
  const emailCol = firstDefined_(table.columns["Email Adress"], table.columns["Email Address"]);
  const statusCol = table.columns["Status"];
  const teamCol = table.columns["Team"];
  const positionCol = table.columns["Position"];

  if (emailCol === undefined || teamCol === undefined) {
    return { assignments: [], person: null, error: 'exec database is missing Email/Team columns' };
  }

  const assignments = [];
  let person = null;

  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    if (normalizeEmail_(row[emailCol]) !== emailToFind) continue;
    if (statusCol !== undefined && string_(row[statusCol]).toLowerCase() !== "active") continue;

    const entity = string_(row[teamCol]);
    const position = positionCol === undefined ? "" : string_(row[positionCol]);

    if (!validEntities.has(entity)) {
      return {
        assignments: [],
        person: null,
        error: `Executive assignment references unknown/inactive entity: ${entity}`,
      };
    }
    if (position && !validPositions.has(position)) {
      return {
        assignments: [],
        person: null,
        error: `Executive assignment references unknown/inactive position: ${position}`,
      };
    }

    assignments.push({
      relationship: "Executive",
      entity,
      position: position || null,
      source: "exec_database",
    });

    if (!person) {
      person = {
        email: emailToFind,
        name: valueByHeader_(row, table.columns, "Student Name"),
        studentId: valueByHeader_(row, table.columns, "ID"),
        campus: valueByHeader_(row, table.columns, "Campus"),
      };
    }
  }

  return { assignments, person };
}

function getManualAssignments_(ss, emailToFind, serverId, validEntities, validPositions) {
  const sheet = ss.getSheetByName("discord_assignments");
  if (!sheet) return { assignments: [] };

  const table = readHeaderTable_(sheet);
  const requiredHeaders = ["Server ID", "Email", "Relationship", "Entity", "Position", "Active", "Start Date", "End Date"];
  for (let i = 0; i < requiredHeaders.length; i++) {
    if (table.columns[requiredHeaders[i]] === undefined) {
      return { assignments: [], error: `discord_assignments is missing column: ${requiredHeaders[i]}` };
    }
  }

  const assignments = [];
  const allowedRelationships = new Set(["Executive", "Volunteer", "Member of Board", "Chairperson", "Admin"]);

  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    if (string_(row[table.columns["Server ID"]]) !== serverId) continue;
    if (normalizeEmail_(row[table.columns["Email"]]) !== emailToFind) continue;
    if (!bool_(row[table.columns["Active"]])) continue;
    if (!isDateWindowActive_(row[table.columns["Start Date"]], row[table.columns["End Date"]])) continue;

    const relationship = string_(row[table.columns["Relationship"]]);
    const entity = string_(row[table.columns["Entity"]]);
    const position = string_(row[table.columns["Position"]]);

    if (!allowedRelationships.has(relationship)) {
      return { assignments: [], error: `Unknown relationship in discord_assignments: ${relationship || "(blank)"}` };
    }

    const scoped = relationship === "Executive" || relationship === "Volunteer" || relationship === "Member of Board";
    if (scoped && !entity) {
      return { assignments: [], error: `${relationship} assignment is missing an entity` };
    }
    if (!scoped && entity) {
      return { assignments: [], error: `${relationship} assignment must not specify an entity` };
    }
    if (entity && !validEntities.has(entity)) {
      return { assignments: [], error: `Manual assignment references unknown/inactive entity: ${entity}` };
    }

    if (position && relationship !== "Executive") {
      return { assignments: [], error: `Only Executive assignments may specify a position: ${relationship} / ${position}` };
    }
    if (position && !validPositions.has(position)) {
      return { assignments: [], error: `Manual assignment references unknown/inactive position: ${position}` };
    }

    assignments.push({
      relationship,
      entity: entity || null,
      position: position || null,
      source: "discord_assignments",
    });
  }

  return { assignments };
}

function getActiveKeys_(ss, sheetName, serverId, keyHeader) {
  const sheet = ss.getSheetByName(sheetName);
  const result = new Set();
  if (!sheet) return result;

  const table = readHeaderTable_(sheet);
  const serverCol = table.columns["Server ID"];
  const keyCol = table.columns[keyHeader];
  const activeCol = table.columns["Active"];
  if (serverCol === undefined || keyCol === undefined) return result;

  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    if (string_(row[serverCol]) !== serverId) continue;
    if (activeCol !== undefined && !bool_(row[activeCol])) continue;
    const key = string_(row[keyCol]);
    if (key) result.add(key);
  }

  return result;
}

function dedupeAssignments_(assignments) {
  const seen = new Set();
  const result = [];

  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i];
    const key = [assignment.relationship || "", assignment.entity || "", assignment.position || ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(assignment);
  }

  return result;
}

function isDateWindowActive_(startValue, endValue) {
  const now = new Date();
  const start = toDate_(startValue);
  const end = toDate_(endValue);

  if (start && now.getTime() < start.getTime()) return false;
  if (end) {
    end.setHours(23, 59, 59, 999);
    if (now.getTime() > end.getTime()) return false;
  }
  return true;
}

function toDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return new Date(value.getTime());
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function readHeaderTable_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (!values.length) return { columns: {}, rows: [] };

  const columns = {};
  const headers = values[0];
  for (let i = 0; i < headers.length; i++) {
    const header = string_(headers[i]);
    if (header) columns[header] = i;
  }

  return { columns, rows: values.slice(1) };
}

function valueByHeader_(row, columns, header) {
  const index = columns[header];
  return index === undefined ? "" : string_(row[index]);
}

function firstDefined_(a, b) {
  return a !== undefined ? a : b;
}

function normalizeEmail_(value) {
  return string_(value).toLowerCase();
}

function string_(value) {
  return value === null || value === undefined ? "" : value.toString().trim();
}

function bool_(value) {
  if (value === true || value === 1) return true;
  const normalized = string_(value).toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "1";
}

// Helper: JSON response
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
