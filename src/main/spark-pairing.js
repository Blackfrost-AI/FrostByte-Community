import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { SPARK_HOSTD_SOURCE } from './spark-hostd.js';

const pythonCommand = script => `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(script).toString('base64')}"))'`;

/** The only command accepted by an app-managed authorized_keys entry. */
export const SPARK_RPC_COMMAND = 'frostbyte-companion-rpc-v1';

// This bridge runs as the paired account, outside the companion. It exposes the
// companion's private Unix socket plus two small host operations needed by the
// desktop: folder discovery and removal of this exact authorized_keys entry.
const BRIDGE_SOURCE = String.raw`${SPARK_HOSTD_SOURCE}
import fcntl,json,os,re,secrets,socket,stat,sys
KEY_TYPE='__FROSTBYTE_KEY_TYPE__'
KEY_BLOB='__FROSTBYTE_KEY_BLOB__'
HELPER='__FROSTBYTE_HELPER__'
RPC='frostbyte-companion-rpc-v1'
ORIGINALS={RPC,'docker exec -i frostbyte-beta node /app/src/agent/client.js','docker exec -i frostbyte-beta node /app/src/agent/client.js --wait-for-sharing','FROSTBYTE_AGENT_HOME="$HOME/.local/share/frostbyte-beta/state" "$HOME/.local/share/frostbyte-beta/current/runtime/bin/node" "$HOME/.local/share/frostbyte-beta/current/src/agent/client.js"','FROSTBYTE_AGENT_HOME="$HOME/.local/share/frostbyte-beta/state" "$HOME/.local/share/frostbyte-beta/current/runtime/bin/node" "$HOME/.local/share/frostbyte-beta/current/src/agent/client.js" --wait-for-sharing'}
MAX_INPUT=12*1024*1024
MAX_OUTPUT=8*1024*1024
ACTIONS={'status','files','torrent:add','torrent:pause','torrent:resume','torrent:remove','inventory:kind','inventory:sharing','inventory:remove','seed','hf:peer','hf:add','hf:pause','hf:resume','hf:clear','hf:remove','device:telemetry','device:recipes','device:control','ipfs:inspect','ipfs:add','ipfs:control','ipfs:sharing','assistant:models','assistant:chat:start','assistant:chat:cancel'}
ACTIONS.add('hf:restore')
LONG={'seed','hf:peer','inventory:sharing','device:control','assistant:chat:start'}
def fail(message):
 sys.stderr.write(message+'\n'); raise SystemExit(1)
def result(data):
 sys.stdout.write(json.dumps({'ok':True,'data':data},separators=(',',':'))+'\n')
def owned_dir(folder):
 st=os.lstat(folder)
 if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_uid!=os.getuid(): fail('Unsafe FrostByte pairing folder.')
def directory_fd(folder):
 flags=os.O_RDONLY|getattr(os,'O_DIRECTORY',0)|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_CLOEXEC',0)
 try: fd=os.open(folder,flags)
 except OSError: fail('Unsafe FrostByte pairing folder.')
 held=os.fstat(fd); current=os.lstat(folder)
 if not stat.S_ISDIR(held.st_mode) or held.st_uid!=os.getuid() or held.st_dev!=current.st_dev or held.st_ino!=current.st_ino:
  os.close(fd); fail('Unsafe FrostByte pairing folder.')
 return fd
def keys_lock(directory):
 name='.frostbyte-authorized-keys.lock'
 try: fd=os.open(name,os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_CLOEXEC',0),0o600,dir_fd=directory)
 except OSError: fail('Unsafe FrostByte authorized_keys lock.')
 held=os.fstat(fd); current=os.stat(name,dir_fd=directory,follow_symlinks=False)
 if (not stat.S_ISREG(held.st_mode) or held.st_uid!=os.getuid() or held.st_nlink!=1
     or held.st_dev!=current.st_dev or held.st_ino!=current.st_ino):
  os.close(fd); fail('Unsafe FrostByte authorized_keys lock.')
 os.fchmod(fd,0o600); fcntl.flock(fd,fcntl.LOCK_EX)
 return fd
def read_keys(directory):
 try: fd=os.open('authorized_keys',os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_CLOEXEC',0),dir_fd=directory)
 except FileNotFoundError: return None,b''
 except OSError: fail('Unsafe authorized_keys file.')
 held=os.fstat(fd); current=os.stat('authorized_keys',dir_fd=directory,follow_symlinks=False)
 if (not stat.S_ISREG(held.st_mode) or held.st_uid!=os.getuid() or held.st_nlink!=1 or held.st_size>8*1024*1024
     or held.st_dev!=current.st_dev or held.st_ino!=current.st_ino):
  os.close(fd); fail('Unsafe authorized_keys file.')
 body=os.pread(fd,8*1024*1024+1,0)
 if len(body)!=held.st_size: os.close(fd); fail('Unsafe authorized_keys file.')
 return fd,body
def unchanged_keys(directory,fd,before):
 if fd is None:
  try: os.stat('authorized_keys',dir_fd=directory,follow_symlinks=False); return False
  except FileNotFoundError: return True
 held=os.fstat(fd)
 try: current=os.stat('authorized_keys',dir_fd=directory,follow_symlinks=False)
 except OSError: return False
 return (stat.S_ISREG(held.st_mode) and held.st_uid==os.getuid() and held.st_nlink==1
         and held.st_dev==current.st_dev and held.st_ino==current.st_ino
         and held.st_size==len(before) and os.pread(fd,len(before)+1,0)==before)
def replace_keys(directory,original,before,updated):
 if updated==before: return
 name='.authorized_keys.frostbyte-'+str(os.getpid())+'-'+secrets.token_hex(12)+'.tmp'
 fd=None; created=None; published=False
 try:
  fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_CLOEXEC',0),0o600,dir_fd=directory)
  created=os.fstat(fd); offset=0
  while offset<len(updated):
   count=os.write(fd,updated[offset:])
   if count<=0: fail('Could not write authorized_keys.')
   offset+=count
  os.fsync(fd)
  held=os.fstat(fd); current=os.stat(name,dir_fd=directory,follow_symlinks=False)
  if (not stat.S_ISREG(held.st_mode) or held.st_uid!=os.getuid() or held.st_nlink!=1
      or held.st_dev!=current.st_dev or held.st_ino!=current.st_ino): fail('Unsafe authorized_keys temporary file.')
  if not unchanged_keys(directory,original,before): fail('authorized_keys changed while FrostByte was updating it.')
  os.replace(name,'authorized_keys',src_dir_fd=directory,dst_dir_fd=directory); published=True; os.fsync(directory)
 finally:
  if fd is not None: os.close(fd)
  if not published and created is not None:
   try:
    current=os.stat(name,dir_fd=directory,follow_symlinks=False)
    if current.st_dev==created.st_dev and current.st_ino==created.st_ino: os.unlink(name,dir_fd=directory)
   except OSError: pass
def key_line(line):
 return re.search(r'(^|[ ,])'+re.escape(KEY_TYPE+' '+KEY_BLOB)+r'(?=\s|$)',line.strip()) is not None
def revoke():
 folder=os.path.expanduser('~/.ssh')
 owned_dir(folder)
 directory=directory_fd(folder); lock=keys_lock(directory); original=None
 try:
  original,body=read_keys(directory)
  token=(KEY_TYPE+' '+KEY_BLOB).encode('ascii')
  pattern=re.compile(rb'(^|[ ,])'+re.escape(token)+rb'(?=\s|$)')
  kept=[line for line in body.splitlines(True) if pattern.search(line.strip()) is None]
  replace_keys(directory,original,body,b''.join(kept))
 finally:
  if original is not None: os.close(original)
  os.close(lock); os.close(directory)
 try: os.unlink(os.path.expanduser('~/.ssh/frostbyte/'+HELPER))
 except FileNotFoundError: pass
 result({'revoked':True})
def folders(request):
 home=os.path.realpath(os.path.expanduser('~'))
 roots=[home]
 for candidate in ['/Volumes','/media','/mnt','/run/media']:
  if os.path.isdir(candidate): roots.append(os.path.realpath(candidate))
 value=request.get('path') or home
 if not isinstance(value,str) or len(value)>4096 or not os.path.isabs(value) or any(ord(c)<32 for c in value): fail('Choose an absolute folder on the device.')
 current=os.path.realpath(value)
 if not os.path.isdir(current): fail('Folder is not available on the device.')
 if not any(os.path.commonpath([root,current])==root for root in roots): fail('Choose a folder in your home directory or on a mounted storage drive.')
 boundary=max((root for root in roots if os.path.commonpath([root,current])==root),key=len)
 found=[]
 try:
  with os.scandir(current) as entries:
   for entry in entries:
    if not entry.name.startswith('.') and entry.is_dir(follow_symlinks=False): found.append({'name':entry.name[:255],'path':os.path.realpath(entry.path)})
    if len(found)>=500: break
 except OSError: fail('Folder is not available on the device.')
 shortcuts=[]
 for name,value in [('Home',home),('External drives','/Volumes'),('External drives','/media'),('Mounted storage','/mnt'),('Removable storage','/run/media')]:
  if os.path.isdir(value): shortcuts.append({'name':name,'path':os.path.realpath(value)})
 parent=current if current==boundary else os.path.dirname(current)
 result({'path':current,'parent':parent,'folders':sorted(found,key=lambda x:x['name'].lower()),'shortcuts':shortcuts})
if os.environ.get('SSH_ORIGINAL_COMMAND') not in ORIGINALS: fail('This FrostByte key accepts companion requests only.')
raw=sys.stdin.buffer.read(MAX_INPUT+1)
if len(raw)>MAX_INPUT: fail('FrostByte request is too large.')
try: request=json.loads(raw)
except Exception: fail('FrostByte request is not valid JSON.')
if not isinstance(request,dict) or len(request)>32 or not isinstance(request.get('action'),str): fail('Invalid FrostByte request.')
pending=[(request,0)];nodes=0
while pending:
 value,depth=pending.pop();nodes+=1
 if nodes>50000 or depth>8: fail('FrostByte request is too complex.')
 if isinstance(value,dict):
  if len(value)>32: fail('FrostByte request is too complex.')
  pending.extend((child,depth+1) for child in value.values())
 elif isinstance(value,list):
  if len(value)>5000: fail('FrostByte request is too complex.')
  pending.extend((child,depth+1) for child in value)
action=request['action']
if action=='pairing:ping': result({'restricted':True})
elif action=='pairing:revoke': revoke()
elif action=='host:folders': folders(request)
elif action in {'device:telemetry','device:recipes','device:control'} and sys.platform.startswith('linux'):
 try: result(spark_hostd_request(request))
 except Exception as error: fail(str(error) if isinstance(error,ValueError) else 'Device management could not be verified.')
elif action in ACTIONS:
 root=os.path.expanduser('~/.local/share/frostbyte-beta/state')
 if os.path.realpath(root)!=root: fail('Unsafe FrostByte companion state folder.')
 try:
  st=os.stat(root)
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid(): fail('Unsafe FrostByte companion state folder.')
 except OSError: fail('FrostByte companion is not installed.')
 endpoint=os.path.join(root,'control.sock')
 try:
  st=os.lstat(endpoint)
  if not stat.S_ISSOCK(st.st_mode) or st.st_uid!=os.getuid(): fail('Unsafe FrostByte companion socket.')
  client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
  client.settimeout(30*60 if action in LONG and (action!='inventory:sharing' or request.get('enabled') is True) else 40)
  client.connect(endpoint); client.sendall(raw.rstrip(b'\r\n')+b'\n'); client.shutdown(socket.SHUT_WR)
  output=bytearray()
  while True:
   chunk=client.recv(65536)
   if not chunk: break
   if action=='assistant:chat:start':
    sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
    continue
   output.extend(chunk)
   if len(output)>MAX_OUTPUT: fail('FrostByte companion response is too large.')
  client.close()
  if action=='assistant:chat:start': raise SystemExit(0)
  if not output: fail('FrostByte companion returned no response.')
  sys.stdout.buffer.write(output)
 except (OSError,socket.timeout) as error: fail('Cannot contact the FrostByte companion: '+str(error))
else: fail('Unsupported FrostByte request.')
`;

// Keep the fixed exec request below SSH implementations' 32 KiB packet limit.
const bridgeBase64 = deflateSync(Buffer.from(BRIDGE_SOURCE)).toString('base64');

/**
 * Add, migrate, or remove one app-managed key. The command is transported over
 * a password or a legacy app key only; all variable data remains on JSON stdin.
 */
export const SPARK_PAIR_COMMAND = pythonCommand(String.raw`
import base64,fcntl,hashlib,json,os,re,secrets,stat,sys,zlib
raw=sys.stdin.buffer.read(8193)
if len(raw)>8192: raise Exception('Pairing request is too large')
try: r=json.loads(raw)
except Exception: raise Exception('Invalid pairing request')
if not isinstance(r,dict) or len(r)>4: raise Exception('Invalid pairing request')
key=r.get('publicKey')
if not isinstance(key,str) or len(key)>2048 or any(ord(c)<32 or ord(c)==127 for c in key): raise Exception('Invalid pairing key')
parts=key.split()
if len(parts)<2 or parts[0]!='ssh-ed25519': raise Exception('Invalid pairing key')
try:
 blob=base64.b64decode(parts[1],validate=True)
except Exception: raise Exception('Invalid pairing key')
if len(blob)<32 or len(blob)>1024: raise Exception('Invalid pairing key')
key_type,key_blob=parts[:2]
identifier=hashlib.sha256((key_type+' '+key_blob).encode()).hexdigest()[:24]
helper_name='bridge-'+identifier+'.py'
home=os.path.expanduser('~')
folder=os.path.join(home,'.ssh')
if not os.path.lexists(folder): os.mkdir(folder,0o700)
st=os.lstat(folder)
if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_uid!=os.getuid(): raise Exception('Your .ssh folder must be owned by your account and cannot be a symbolic link')
os.chmod(folder,0o700)
helpers=os.path.join(folder,'frostbyte')
if not os.path.lexists(helpers): os.mkdir(helpers,0o700)
st=os.lstat(helpers)
if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_uid!=os.getuid(): raise Exception('Unsafe FrostByte pairing folder')
os.chmod(helpers,0o700)
def directory_fd(folder):
 flags=os.O_RDONLY|getattr(os,'O_DIRECTORY',0)|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_CLOEXEC',0)
 fd=os.open(folder,flags); held=os.fstat(fd); current=os.lstat(folder)
 if (not stat.S_ISDIR(held.st_mode) or held.st_uid!=os.getuid()
     or held.st_dev!=current.st_dev or held.st_ino!=current.st_ino):
  os.close(fd); raise Exception('Unsafe FrostByte pairing folder')
 return fd
def keys_lock(directory):
 name='.frostbyte-authorized-keys.lock'
 fd=os.open(name,os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_CLOEXEC',0),0o600,dir_fd=directory)
 held=os.fstat(fd); current=os.stat(name,dir_fd=directory,follow_symlinks=False)
 if (not stat.S_ISREG(held.st_mode) or held.st_uid!=os.getuid() or held.st_nlink!=1
     or held.st_dev!=current.st_dev or held.st_ino!=current.st_ino):
  os.close(fd); raise Exception('Unsafe FrostByte authorized_keys lock')
 os.fchmod(fd,0o600); fcntl.flock(fd,fcntl.LOCK_EX)
 return fd
def read_keys(directory):
 try: fd=os.open('authorized_keys',os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_CLOEXEC',0),dir_fd=directory)
 except FileNotFoundError: return None,b''
 held=os.fstat(fd); current=os.stat('authorized_keys',dir_fd=directory,follow_symlinks=False)
 if (not stat.S_ISREG(held.st_mode) or held.st_uid!=os.getuid() or held.st_nlink!=1 or held.st_size>8*1024*1024
     or held.st_dev!=current.st_dev or held.st_ino!=current.st_ino):
  os.close(fd); raise Exception('Unsafe authorized_keys file')
 body=os.pread(fd,8*1024*1024+1,0)
 if len(body)!=held.st_size: os.close(fd); raise Exception('Unsafe authorized_keys file')
 return fd,body
def unchanged_keys(directory,fd,before):
 if fd is None:
  try: os.stat('authorized_keys',dir_fd=directory,follow_symlinks=False); return False
  except FileNotFoundError: return True
 held=os.fstat(fd)
 try: current=os.stat('authorized_keys',dir_fd=directory,follow_symlinks=False)
 except OSError: return False
 return (stat.S_ISREG(held.st_mode) and held.st_uid==os.getuid() and held.st_nlink==1
         and held.st_dev==current.st_dev and held.st_ino==current.st_ino
         and held.st_size==len(before) and os.pread(fd,len(before)+1,0)==before)
def atomic_file(directory,target,updated,verify=None):
 temporary='.'+target+'.frostbyte-'+str(os.getpid())+'-'+secrets.token_hex(12)+'.tmp'
 fd=None; created=None; published=False
 try:
  fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_CLOEXEC',0),0o600,dir_fd=directory)
  created=os.fstat(fd); offset=0
  while offset<len(updated):
   count=os.write(fd,updated[offset:])
   if count<=0: raise Exception('Could not write FrostByte pairing state')
   offset+=count
  os.fsync(fd)
  held=os.fstat(fd); current=os.stat(temporary,dir_fd=directory,follow_symlinks=False)
  if (not stat.S_ISREG(held.st_mode) or held.st_uid!=os.getuid() or held.st_nlink!=1
      or held.st_dev!=current.st_dev or held.st_ino!=current.st_ino): raise Exception('Unsafe FrostByte pairing temporary file')
  if verify is not None and not verify(): raise Exception('authorized_keys changed while FrostByte was updating it')
  os.replace(temporary,target,src_dir_fd=directory,dst_dir_fd=directory); published=True; os.fsync(directory)
 finally:
  if fd is not None: os.close(fd)
  if not published and created is not None:
   try:
    current=os.stat(temporary,dir_fd=directory,follow_symlinks=False)
    if current.st_dev==created.st_dev and current.st_ino==created.st_ino: os.unlink(temporary,dir_fd=directory)
   except OSError: pass
directory=directory_fd(folder)
helper_directory=directory_fd(helpers)
lock=keys_lock(directory)
original=None
try:
 original,body=read_keys(directory)
 token=(key_type+' '+key_blob).encode('ascii')
 pattern=re.compile(rb'(^|[ ,])'+re.escape(token)+rb'(?=\s|$)')
 owns=lambda line: pattern.search(line.strip()) is not None
 matching=any(owns(line) for line in body.splitlines())
 action=r.get('action')
 if action=='migrate' and not matching: raise Exception('The legacy FrostByte pairing key was not found')
 kept=b''.join(line for line in body.splitlines(True) if not owns(line))
 if action in ('add','migrate'):
  source=zlib.decompress(base64.b64decode('${bridgeBase64}')).decode().replace('__FROSTBYTE_KEY_TYPE__',key_type).replace('__FROSTBYTE_KEY_BLOB__',key_blob).replace('__FROSTBYTE_HELPER__',helper_name).encode()
  target=os.path.join(helpers,helper_name)
  if os.path.lexists(target):
   helper_stat=os.lstat(target)
   if not stat.S_ISREG(helper_stat.st_mode) or stat.S_ISLNK(helper_stat.st_mode) or helper_stat.st_uid!=os.getuid() or helper_stat.st_nlink!=1: raise Exception('Unsafe FrostByte pairing helper')
  atomic_file(helper_directory,helper_name,source)
  canonical=('restrict,command="cd && exec python3 .ssh/frostbyte/'+helper_name+'" '+key+'\n').encode()
  if kept and not kept.endswith((b'\n',b'\r')): kept+=b'\n'
  updated=kept+canonical
  remove_helper=False
 elif action=='remove': updated=kept; remove_helper=True
 else: raise Exception('Unsupported pairing action')
 if updated!=body: atomic_file(directory,'authorized_keys',updated,lambda: unchanged_keys(directory,original,body))
 if remove_helper:
  try: os.unlink(helper_name,dir_fd=helper_directory); os.fsync(helper_directory)
  except FileNotFoundError: pass
 print(json.dumps({'ok':True,'restricted':action in ('add','migrate')}))
finally:
 if original is not None: os.close(original)
 os.close(lock); os.close(helper_directory); os.close(directory)
`);

export function pairingIdentity(profile = {}) {
  if (typeof profile.publicKey !== 'string' || typeof profile.privateKey !== 'string') return '';
  return createHash('sha256').update([profile.host, profile.username, profile.port || 22, profile.hostKey, profile.publicKey].join('\0')).digest('hex');
}
