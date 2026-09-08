"""Guarded local synthetic runner; records natural process exit separately from app.close."""
import argparse, json, os, pathlib, subprocess, time
p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--output',required=True);p.add_argument('--corpus',required=True);p.add_argument('--enum-repair',action='store_true');p.add_argument('--omission-control',action='store_true');p.add_argument('--native-embedding',action='store_true');a=p.parse_args()
repo=pathlib.Path(a.repo).resolve();out=pathlib.Path(a.output).resolve();out.parent.mkdir(parents=True,exist_ok=True)
# These names/ports are exclusively created for this synthetic experiment.
subprocess.run(['docker','exec','engram-eval-pg-20260908','dropdb','-U','postgres','--if-exists','engram_lifecycle_synthetic'],check=True)
subprocess.run(['docker','exec','engram-eval-pg-20260908','createdb','-U','postgres','engram_lifecycle_synthetic'],check=True)
subprocess.run(['docker','exec','engram-eval-redis-20260908','redis-cli','FLUSHALL'],check=True,stdout=subprocess.DEVNULL)
env=dict(os.environ,DATABASE_URL='postgresql://postgres:lifecycle_scratch@127.0.0.1:55441/engram_lifecycle_synthetic',REDIS_URL='redis://127.0.0.1:16391',EMBEDDING_PROVIDER='local',EMBEDDING_MODEL='bge-base-en-v1.5',VECTOR_SEARCH_MODEL='bge-base-en-v1.5',LOCAL_EMBED_URL='http://127.0.0.1:8080',LOCAL_EMBED_MODEL='bge-base-en-v1.5',LOCAL_EMBED_DIMENSIONS='768',ENSEMBLE_ENABLED='true',RERANK_ENABLED='false',NODE_ENV='test',OPENAI_API_KEY='unused-local-test',LLM_PROVIDER='lmstudio',LMSTUDIO_URL='http://127.0.0.1:11435/v1',LLM_MODEL='openchat-3.6-8b-20240522-8bit',LIFECYCLE_CORPUS=str(pathlib.Path(a.corpus).resolve()),LIFECYCLE_OUTPUT=str(out),LIFECYCLE_SERIAL_EMBED='0' if a.native_embedding else '1',LIFECYCLE_DIAGNOSTIC_ENUM='1' if a.enum_repair else '0',LIFECYCLE_OMISSION_CONTROL='1' if a.omission_control else '0')
with open(out.with_suffix('.migrations.log'),'w') as log: subprocess.run([str(repo/'node_modules/.bin/prisma'),'migrate','deploy'],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
start=time.monotonic();closed=None;termination=None
with open(out.with_suffix('.log'),'w') as log:
 child=subprocess.Popen(['node','scripts/audit/lifecycle-evaluation.cjs'],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT)
 while child.poll() is None:
  now=time.monotonic()
  if out.exists():
   try:
    report=json.loads(out.read_text())
    if report.get('appCloseReturned') and closed is None: closed=now
   except json.JSONDecodeError: pass
  if (closed is not None and now-closed>20) or now-start>900:
   termination='app-close still alive after 20s' if closed is not None else '900s run deadline';child.terminate()
   try:child.wait(timeout=10)
   except subprocess.TimeoutExpired:child.kill();child.wait()
   break
  time.sleep(1)
meta={'naturalExit':termination is None,'exitCode':child.returncode,'termination':termination,'elapsedSeconds':round(time.monotonic()-start,2),'repo':str(repo),'head':head}
out.with_suffix('.process.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(meta))
