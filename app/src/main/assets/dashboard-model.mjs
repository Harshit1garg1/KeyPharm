import {actionLabel} from './model.mjs';
export const RECENT_LIMIT = 50;

export const sections = {
  sessions: {title:'Sessions', description:'Test setup, verification, closure and scan evidence.'},
  pallets: {title:'Pallet checks', description:'Pallet identification attempts and their reader evidence.'},
  scans: {title:'Carton scans', description:'First passes and rescans, with results and reader settings.'},
  exceptions: {title:'Exceptions', description:'Missing and unexpected EPCs, plus interrupted scans.'},
  activity: {title:'Activity', description:'Actions recorded by the handheld.'}
};

export function indexRecords(sessions) {
  const rows = {sessions:[], pallets:[], scans:[], exceptions:[], activity:[]};
  const results = {Match:0, Incomplete:0, Hold:0, Interrupted:0};
  let closed = 0;
  for (const session of sessions) {
    const order = (category, data) => rows[category].push({session, ...data});
    const test = session.testId || 'Unnamed session';
    const sessionPallet = session.manifest?.pallet;
    if (session.closedAt) closed++;
    order('sessions', {id:session.id, title:test, status:session.closedAt ? 'Closed' : 'Open',
      description:[sessionPallet,session.location,session.creator].filter(Boolean).join(' / '),
      at:session.closedAt || session.createdAt});
    for (const [i,attempt] of (session.palletAttempts ?? []).entries()) {
      order('pallets', {id:session.id + ':' + i, title:attempt.lockedPallet || sessionPallet || 'Pallet check',
        description:[test,attempt.actor].filter(Boolean).join(' / '), status:attempt.result || 'Unconfirmed',
        at:attempt.endedAt || attempt.startedAt, attempt});
    }
    for (const [i,run] of (session.runs ?? []).entries()) {
      if (run.state === 'Reading') continue;
      const scan = i === 0 ? 'First pass' : 'Rescan ' + i;
      const status = run.state === 'Interrupted' ? 'Interrupted' : (run.result?.status || run.state || 'Unknown');
      const at = run.endedAt || run.startedAt;
      const id = session.id + ':' + i;
      if (Object.hasOwn(results,status)) results[status]++;
      order('scans',{id, title:scan, description:[test,run.operator].filter(Boolean).join(' / '), status, at, run});
      for (const [field,title,status] of [['missing','Missing EPC','Missing'],['extra','Unexpected EPC','Unexpected']]) {
        for (const epc of run.result?.[field] ?? []) {
          order('exceptions',{id:id + ':' + field + ':' + epc, title, description:test + ' / ' + epc, status, at, epc, scan, run});
        }
      }
      if (status === 'Interrupted') {
        order('exceptions',{id:id + ':interrupted', title:'Interrupted scan', description:test, status, at, scan, run});
      }
    }
    for (const [i,log] of (session.logs ?? []).entries()) {
      order('activity',{id:session.id + ':' + i, title:actionLabel(log.action) || 'Activity event',
        description:[test,log.actor].filter(Boolean).join(' / '), at:log.at, log});
    }
  }
  for (const group of Object.values(rows)) group.sort((a,b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const exceptionGroups = new Map();
  for (const item of rows.exceptions) {
    const session = item.session;
    if (!exceptionGroups.has(session.id)) {
      exceptionGroups.set(session.id,{id:session.id,session,title:session.testId || 'Unnamed session',
        description:[session.manifest?.pallet,session.location].filter(Boolean).join(' / '),at:item.at,exceptions:[]});
    }
    exceptionGroups.get(session.id).exceptions.push(item);
  }
  const exceptionSessions = [...exceptionGroups.values()].map(row => ({...row,
    status:row.exceptions.length + (row.exceptions.length === 1 ? ' exception' : ' exceptions')}));
  return {rows, results, closed, exceptionSessions};
}
