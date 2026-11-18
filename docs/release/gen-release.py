# Regenerates docs/release/02a-02d and 03 from Supabase/migrations: python docs/release/gen-release.py <repo root>
import os,re,sys
root=sys.argv[1]; os.chdir(root)
mig='Supabase/migrations'
files=sorted(f for f in os.listdir(mig) if f[:3].isdigit() and 19<=int(f[:3])<=61 and int(f[:3])!=20)
parts={'a':(19,31),'b':(32,43),'c':(44,53),'d':(54,61)}
# Tables that already exist in production (created by 001-018); an index on them can take a while.
big=('public.leads','public.timeline_events','public.tasks','public.notifications','public.scheduled_actions','public.workflow_runs','public.calls','public.meetings','public.whatsapp_outbound_messages','public.proposals','public.lead_contact_channels','public.message_templates')
slow_total=[]
for key,(lo,hi) in parts.items():
    sel=[f for f in files if lo<=int(f[:3])<=hi]
    out=[f"-- =============================================================================\n-- REL-1 release: migrations {sel[0][:3]}-{sel[-1][:3]} (part {key.upper()} of 4). Generated from Supabase/migrations; do not edit by hand.\n-- Paste the WHOLE file into Supabase -> SQL editor -> Run. Every migration here is additive and re-runnable:\n-- if a part fails, fix the cause and run the same part again. Parts A, B, C, D in order; 020 comes later (03-migration-020.sql).\n-- Lines marked 'SLOW ON A BIG TABLE' build an index on a table production already has (see 00-READ-ME-FIRST, step 4).\n-- Files: {', '.join(sel)}\n-- =============================================================================\n"]
    for f in sel:
        sql=open(os.path.join(mig,f),encoding='utf-8').read()
        slow=[f"{m.group(3)} on {m.group(4)}" for m in re.finditer(r'create\s+(unique\s+)?index\s+(if not exists\s+)?(\w+)\s+on\s+(public\.\w+)',sql,re.I) if m.group(4).lower() in big]
        hdr=f"\n\n-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n-- >>> {f}\n"
        if slow:
            hdr+="-- >>> SLOW ON A BIG TABLE: "+"; ".join(slow)+"\n"
            slow_total+=[(f,s) for s in slow]
        out.append(hdr+"-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n\n"+sql)
    open(f'docs/release/02{key}-migrations-{sel[0][:3]}-{sel[-1][:3]}.sql','w',encoding='utf-8',newline='\n').write(''.join(out))
s020=open(os.path.join(mig,'020_dnc_exit_only_to_active.sql'),encoding='utf-8').read()
open('docs/release/03-migration-020.sql','w',encoding='utf-8',newline='\n').write("-- =============================================================================\n-- REL-1 release: migration 020. Run it AFTER the new API + worker are deployed (00-READ-ME-FIRST step 7). Re-runnable.\n-- =============================================================================\n\n"+s020)
for f,s in slow_total: print(f"{f}: {s}")
