'use strict';
const trim = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// One line describing a tool call, for the card ("Bash: npm test", "Edit app.js").
function describeTool(name, input) {
  input = input || {};
  const base = p => String(p || '').split('/').pop();
  switch (name) {
    case 'Bash': case 'PowerShell': return trim(input.description || input.command, 90);
    case 'Edit': case 'Write': case 'Read': case 'NotebookEdit': return `${name} ${base(input.file_path || input.notebook_path)}`;
    case 'Grep': return `Grep ${trim(input.pattern, 40)}`;
    case 'Glob': return `Glob ${trim(input.pattern, 40)}`;
    case 'Agent': return `Agent: ${trim(input.description || input.prompt, 70)}`;
    case 'WebFetch': try { return 'Fetch ' + new URL(input.url).host; } catch { return 'WebFetch'; }
    case 'WebSearch': return `Search ${trim(input.query, 60)}`;
    case 'Skill': return `Skill ${input.skill || ''}`;
    default: return name || '?';
  }
}

module.exports = { describeTool };
