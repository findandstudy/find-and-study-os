import {
  pgTable,
  serial,
  text,
  boolean,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

export const rolesTable = pgTable("roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("blue"),
  isSystem: boolean("is_system").notNull().default(false),
  permissions: jsonb("permissions").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Role = typeof rolesTable.$inferSelect;
export type InsertRole = typeof rolesTable.$inferInsert;

export const PERMISSION_CATEGORIES = {
  dashboard: {
    label: "Dashboard",
    permissions: {
      "dashboard.view": "View Dashboard",
    },
  },
  leads: {
    label: "Leads",
    permissions: {
      "leads.view": "View Leads",
      "leads.create": "Create Leads",
      "leads.edit": "Edit Leads",
      "leads.delete": "Delete Leads",
      "leads.assign": "Assign Leads",
      "leads.import": "Import Leads",
      "leads.change_stage": "Change Lead Stage",
      "leads.view_commission": "View Lead Revenue/Value",
    },
  },
  applications: {
    label: "Applications",
    permissions: {
      "applications.view": "View Applications",
      "applications.create": "Create Applications",
      "applications.edit": "Edit Applications",
      "applications.delete": "Delete Applications",
      "applications.change_stage": "Change Application Stage",
      "applications.change_student_app_stage":
        "Change Student/Application Stage",
      "applications.view_commission": "View Commission",
    },
  },
  students: {
    label: "Students",
    permissions: {
      "students.view": "View Students",
      "students.create": "Create Students",
      "students.edit": "Edit Students",
      "students.delete": "Delete Students",
      "students.import": "Import Students",
      "students.change_stage": "Change Student Stage",
      "students.view_commission": "View Student Revenue",
    },
  },
  records: {
    label: "Records & Assignment",
    permissions: {
      "records.change_assigned": "Change Assigned Person",
      "records.view_others": "See Others' Records",
      "records.view_unassigned": "See Unassigned Records",
      "records.assign_button": "See/Use Assign Button",
      "records.move_cards": "Move Cards on Canvas",
      "records.cascade_assignment": "Cascade Assignment to Linked Records",
    },
  },
  documents: {
    label: "Documents",
    permissions: {
      "documents.view": "View Documents",
      "documents.upload": "Upload Documents",
      "documents.download": "Download Documents",
      "documents.delete": "Delete Documents",
      "documents.verify": "Verify Documents",
    },
  },
  course_finder: {
    label: "Course Finder",
    permissions: {
      "course_finder.access": "Access Course Finder",
    },
  },
  agents: {
    label: "Agents",
    permissions: {
      "agents.view": "View Agents",
      "agents.create": "Create Agents",
      "agents.edit": "Edit Agents",
      "agents.delete": "Delete Agents",
      "agents.manage_sub_agents": "Manage Sub-Agents",
      "agents.impersonate": "Login as Agent",
    },
  },
  finance: {
    label: "Finance",
    permissions: {
      "finance.view": "View Finance Overview",
      "finance.commissions_view": "View Commissions",
      "finance.commissions_manage": "Manage Commissions",
      "finance.service_fees_view": "View Service Fees",
      "finance.service_fees_manage": "Manage Service Fees",
      "finance.offset_view": "View Offset",
      "finance.offset_manage": "Manage Offset",
    },
  },
  reporting: {
    label: "Reporting & Intelligence",
    permissions: {
      "reporting.view": "View Reporting Center",
      "reporting.operations": "View Funnel and Operations Reports",
      "reporting.finance": "View Finance Reports",
      "reporting.workforce": "View Workforce Reports",
      "reporting.export": "Export Approved Reports",
      "reporting.manage": "Manage Reporting Definitions and Delivery",
    },
  },
  social: {
    label: "Social Media Operations",
    permissions: {
      "social.view": "View Social Media Operations",
      "social.manage": "Manage Social Accounts and Content Briefs",
      "social.approve": "Approve Social Media Content",
    },
  },
  catalog: {
    label: "Catalog",
    permissions: {
      "catalog.view": "View Catalog",
      "catalog.create": "Create Entries",
      "catalog.edit": "Edit Entries",
      "catalog.delete": "Delete Entries",
      "catalog.import": "Bulk Import",
    },
  },
  users: {
    label: "User Management",
    permissions: {
      "users.view": "View Users",
      "users.create": "Create Users",
      "users.edit": "Edit Users",
      "users.delete": "Delete Users",
      "users.manage_roles": "Manage Roles & Permissions",
    },
  },
  audit: {
    label: "Audit",
    permissions: {
      "audit.view": "View Audit Logs",
    },
  },
  settings: {
    label: "Settings",
    permissions: {
      "settings.view": "View Settings",
      "settings.edit": "Edit Settings",
      "settings.branding": "Manage Branding",
    },
  },
  contract_templates: {
    label: "Contract Templates",
    permissions: {
      "contract_templates.view": "View Contract Templates",
      "contract_templates.manage": "Manage Contract Templates",
    },
  },
  contracts: {
    label: "Contracts",
    permissions: {
      "contracts.view": "View Contracts",
      "contracts.manage": "Manage Contracts",
    },
  },
  self_fill_links: {
    label: "Self-Fill Links",
    permissions: {
      "self_fill_links.view": "View Self-Fill Links",
      "self_fill_links.manage": "Manage Self-Fill Links",
    },
  },
  university_contracts: {
    label: "University Contracts",
    permissions: {
      "university_contracts.view": "View University Contracts",
      "university_contracts.manage": "Manage University Contracts",
    },
  },
  company_contracts: {
    label: "Company Contracts",
    permissions: {
      "company_contracts.view": "View Company Contracts",
      "company_contracts.manage": "Manage Company Contracts",
    },
  },
  academy: {
    label: "Academy",
    permissions: {
      "academy.access": "Access Academy Find And Study (SSO)",
    },
  },
} as const;

export function getAllPermissions(): string[] {
  const perms: string[] = [];
  for (const cat of Object.values(PERMISSION_CATEGORIES)) {
    perms.push(...Object.keys(cat.permissions));
  }
  return perms;
}

export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: getAllPermissions(),
  admin: getAllPermissions().filter(
    (p) =>
      !p.startsWith("finance.commissions") && !p.startsWith("finance.offset"),
  ),
  staff: [
    "dashboard.view",
    "leads.view",
    "leads.create",
    "leads.edit",
    "leads.assign",
    "leads.change_stage",
    "applications.view",
    "applications.create",
    "applications.edit",
    "applications.change_stage",
    "applications.change_student_app_stage",
    "students.view",
    "students.create",
    "students.edit",
    "students.change_stage",
    "documents.view",
    "documents.upload",
    "documents.download",
    "documents.verify",
    "course_finder.access",
    "records.view_unassigned",
    "records.move_cards",
  ],
  consultant: [
    "dashboard.view",
    "leads.view",
    "leads.create",
    "leads.edit",
    "leads.assign",
    "leads.change_stage",
    "applications.view",
    "applications.create",
    "applications.edit",
    "applications.change_stage",
    "applications.change_student_app_stage",
    "students.view",
    "students.create",
    "students.edit",
    "students.change_stage",
    "documents.view",
    "documents.upload",
    "documents.download",
    "documents.verify",
    "course_finder.access",
    "records.view_unassigned",
    "records.move_cards",
  ],
  accountant: [
    "dashboard.view",
    "reporting.view",
    "reporting.finance",
    "reporting.export",
    "finance.view",
    "finance.commissions_view",
    "finance.commissions_manage",
    "finance.service_fees_view",
    "finance.service_fees_manage",
    "finance.offset_view",
    "finance.offset_manage",
    "documents.view",
    "documents.download",
    "leads.view_commission",
    "applications.view_commission",
    "students.view_commission",
    "contracts.view",
    "contract_templates.view",
    "university_contracts.view",
    "company_contracts.view",
    "self_fill_links.view",
  ],
  student: [
    "dashboard.view",
    "applications.view",
    "documents.view",
    "documents.upload",
    "documents.download",
    "course_finder.access",
  ],
  agent: [
    "dashboard.view",
    "leads.view",
    "leads.create",
    "leads.edit",
    "leads.change_stage",
    "applications.view",
    "applications.create",
    "students.view",
    "students.create",
    "students.edit",
    "documents.view",
    "documents.upload",
    "documents.download",
    "finance.commissions_view",
    "agents.manage_sub_agents",
    "academy.access",
  ],
  manager: getAllPermissions().filter(
    (p) =>
      !p.startsWith("finance.commissions") &&
      !p.startsWith("finance.offset") &&
      p !== "users.manage_roles" &&
      p !== "settings.branding" &&
      p !== "reporting.manage" &&
      p !== "social.approve",
  ),
  editor: [
    "dashboard.view",
    "catalog.view",
    "catalog.create",
    "catalog.edit",
    "catalog.delete",
    "catalog.import",
    "documents.view",
    "documents.upload",
    "documents.download",
  ],
  sub_agent: [
    "dashboard.view",
    "leads.view",
    "leads.create",
    "leads.change_stage",
    "applications.view",
    "applications.create",
    "students.view",
    "students.create",
    "documents.view",
    "documents.upload",
    "documents.download",
    "academy.access",
  ],
  agent_staff: [
    "dashboard.view",
    "leads.view",
    "leads.create",
    "leads.edit",
    "leads.change_stage",
    "applications.view",
    "applications.create",
    "students.view",
    "students.create",
    "students.edit",
    "documents.view",
    "documents.upload",
    "documents.download",
    "course_finder.access",
  ],
};

export const DEFAULT_ROLES = [
  {
    name: "super_admin",
    displayName: "Super Admin",
    description: "Full system access — can view and modify everything",
    color: "rose",
    isSystem: true,
  },
  {
    name: "admin",
    displayName: "Admin",
    description: "Administrative access — cannot view commissions and offset",
    color: "red",
    isSystem: true,
  },
  {
    name: "manager",
    displayName: "Manager",
    description: "Management-level access with team oversight capabilities",
    color: "orange",
    isSystem: true,
  },
  {
    name: "staff",
    displayName: "Staff",
    description: "General staff member with operational access",
    color: "blue",
    isSystem: true,
  },
  {
    name: "consultant",
    displayName: "Consultant",
    description:
      "Staff sub-type — handles student consultations and applications",
    color: "indigo",
    isSystem: true,
  },
  {
    name: "accountant",
    displayName: "Accountant",
    description:
      "Staff sub-type — manages finance, commissions and service fees",
    color: "purple",
    isSystem: true,
  },
  {
    name: "editor",
    displayName: "Editor",
    description: "Content editor — manages catalog and document content",
    color: "cyan",
    isSystem: true,
  },
  {
    name: "student",
    displayName: "Student",
    description: "Student user — can view own applications and documents",
    color: "green",
    isSystem: true,
  },
  {
    name: "agent",
    displayName: "Agent",
    description: "External agent partner — manages own leads and sub-agents",
    color: "amber",
    isSystem: true,
  },
  {
    name: "sub_agent",
    displayName: "Sub Agent",
    description: "Sub-agent or employee of an agent partner",
    color: "yellow",
    isSystem: true,
  },
  {
    name: "agent_staff",
    displayName: "Agent Staff",
    description: "Staff member of an agent — permissions set by the agent",
    color: "teal",
    isSystem: true,
  },
];
