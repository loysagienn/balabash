// Static scheduled-task index: task bodies ship inside the app bundle —
// adding one is adding its module here (the scheduler agent does it itself).
// The key IS the task's slug: create_task(kind='code') registers the same
// slug in the database, and the schedule heart joins the two at fire time.
// Each module must export only run(ctx); validation happens at boot
// (src/schedule/catalog.ts). A registry row whose slug is missing here
// sleeps until a rebuild + restart ships the body. See tasks/AGENTS.md.

import * as gmailNewMail from './gmail-new-mail.ts';

export const taskModules: Record<string, Record<string, unknown>> = {
  'gmail-new-mail': gmailNewMail,
};
