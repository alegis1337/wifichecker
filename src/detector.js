// Diff активных проблем по eventid между текущим прогоном и предыдущим (из БД).
export function diffProblems(currentProblems, previousProblems) {
  const prevIds = new Set(previousProblems.map((p) => p.eventid));
  const currIds = new Set(currentProblems.map((p) => p.eventid));
  return {
    newProblems: currentProblems.filter((p) => !prevIds.has(p.eventid)),
    resolvedProblems: previousProblems.filter((p) => !currIds.has(p.eventid)),
  };
}
