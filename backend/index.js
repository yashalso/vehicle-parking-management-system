const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,PUT,PATCH,DELETE,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization"};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}});
const read=async r=>{try{return await r.json()}catch{return {}}};
const roles=(u,...allowed)=>u&&allowed.includes(u.role);
async function auth(req,env){
 const token=req.headers.get("Authorization")?.replace(/^Bearer\s+/i,"");
 if(!token)return null;
 return env.DB.prepare("SELECT u.user_id,u.full_name,u.username,u.role FROM sessions s JOIN users u ON u.user_id=s.user_id WHERE s.token=? AND s.expires_at>datetime('now')").bind(token).first();
}
export default {async fetch(req,env){
 const url=new URL(req.url),p=url.pathname,m=req.method;
 if(m==="OPTIONS")return new Response(null,{headers:cors});
 try{
if (p === "/api/health" && m === "GET") {
  return reply({
    success: true,
    message: "VPMS backend is running!",
    database: "Connected"
  });

  }
  if(p==="/api/login"&&m==="POST"){
   const b=await read(req);if(!b.username||!b.password)return reply({success:false,message:"Username and password required"},400);
   const u=await env.DB.prepare("SELECT * FROM users WHERE username=?").bind(String(b.username).trim()).first();
   if(!u||u.password!==b.password)return reply({success:false,message:"Invalid username or password"},401);
   const token=crypto.randomUUID()+crypto.randomUUID();
   await env.DB.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','+12 hours'))").bind(token,u.user_id).run();
   return reply({success:true,message:"Login successful",token,user:{user_id:u.user_id,full_name:u.full_name,username:u.username,role:u.role}});
  }
  const u=await auth(req,env);
  if(p==="/api/logout"&&m==="POST"){const t=req.headers.get("Authorization")?.replace(/^Bearer\s+/i,"");if(t)await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(t).run();return reply({success:true});}
  if(!u)return reply({success:false,message:"Please log in"},401);
  if(p==="/api/me")return reply({success:true,user:u});
  if(p==="/api/dashboard"){
   const [s,a,e,r]=await Promise.all([
    env.DB.prepare("SELECT COUNT(*) total,SUM(status='occupied') occupied,SUM(status='available') available,SUM(status='unavailable') unavailable FROM parking_slots").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM parking_records WHERE exit_time IS NULL").first(),
    env.DB.prepare("SELECT COUNT(*) n FROM parking_records WHERE date(entry_time)=date('now','localtime')").first(),
    env.DB.prepare("SELECT COALESCE(SUM(total_fee),0) n FROM parking_records WHERE payment_status='paid' AND date(exit_time)=date('now','localtime')").first()]);
   return reply({success:true,stats:{...s,inside:a.n,today_entries:e.n,today_revenue:r.n}});
  }
  if(p==="/api/slots"&&m==="GET"){const r=await env.DB.prepare("SELECT * FROM parking_slots ORDER BY slot_number").all();return reply({success:true,slots:r.results});}
  if(p==="/api/slots"&&m==="POST"){
   if(!roles(u,"admin"))return reply({success:false,message:"Admin only"},403);
   const b=await read(req);if(!b.slot_number||!["car","bike"].includes(b.vehicle_type))return reply({success:false,message:"Enter slot number and vehicle type"},400);
   try{await env.DB.prepare("INSERT INTO parking_slots(slot_number,vehicle_type,is_reserved) VALUES(?,?,?)").bind(b.slot_number.trim().toUpperCase(),b.vehicle_type,b.is_reserved?1:0).run();return reply({success:true,message:"Slot added"});}catch{return reply({success:false,message:"Slot number already exists"},409);}
  }
  let sm = p.match(/^\/api\/slots\/(\d+)$/);
  if(sm&&m==="PATCH"){if(!roles(u,"admin"))return reply({success:false,message:"Admin only"},403);const b=await read(req);await env.DB.prepare("UPDATE parking_slots SET status=COALESCE(?,status),is_reserved=COALESCE(?,is_reserved) WHERE slot_id=?").bind(b.status||null,b.is_reserved===undefined?null:(b.is_reserved?1:0),sm[1]).run();return reply({success:true});}
  if(p==="/api/rates"&&m==="GET"){const r=await env.DB.prepare("SELECT * FROM parking_rates").all();return reply({success:true,rates:r.results});}
  if(p==="/api/rates"&&m==="PUT"){if(!roles(u,"admin"))return reply({success:false,message:"Admin only"},403);const b=await read(req);if(!["car","bike"].includes(b.vehicle_type))return reply({success:false,message:"Invalid vehicle type"},400);await env.DB.prepare("INSERT INTO parking_rates(vehicle_type,slab_6_hours,slab_12_hours,slab_24_hours) VALUES(?,?,?,?) ON CONFLICT(vehicle_type) DO UPDATE SET slab_6_hours=excluded.slab_6_hours,slab_12_hours=excluded.slab_12_hours,slab_24_hours=excluded.slab_24_hours").bind(b.vehicle_type,+b.slab_6_hours,+b.slab_12_hours,+b.slab_24_hours).run();return reply({success:true,message:"Rates saved"});}
  if(p==="/api/entry"&&m==="POST"){
   if(!roles(u,"admin","attendant"))return reply({success:false,message:"Access denied"},403);
   const b=await read(req),reg=String(b.registration_number||"").trim().toUpperCase(),type=b.vehicle_type;
   if(!reg||!["car","bike"].includes(type))return reply({success:false,message:"Registration and vehicle type required"},400);
   const active=await env.DB.prepare("SELECT pr.record_id FROM parking_records pr JOIN vehicles v ON v.vehicle_id=pr.vehicle_id WHERE v.registration_number=? AND pr.exit_time IS NULL").bind(reg).first();
   if(active)return reply({success:false,message:"Vehicle already parked"},409);
   const slot=await env.DB.prepare("SELECT * FROM parking_slots WHERE vehicle_type=? AND status='available' AND is_reserved=0 ORDER BY slot_number LIMIT 1").bind(type).first();
   if(!slot)return reply({success:false,message:"No suitable available slot"},409);
   let v=await env.DB.prepare("SELECT vehicle_id FROM vehicles WHERE registration_number=?").bind(reg).first();
   if(!v){const x=await env.DB.prepare("INSERT INTO vehicles(registration_number,vehicle_type,owner_name,contact_number) VALUES(?,?,?,?)").bind(reg,type,b.owner_name||null,b.contact_number||null).run();v={vehicle_id:x.meta.last_row_id};}
   const x=await env.DB.prepare("INSERT INTO parking_records(vehicle_id,slot_id) VALUES(?,?)").bind(v.vehicle_id,slot.slot_id).run();
   await env.DB.prepare("UPDATE parking_slots SET status='occupied' WHERE slot_id=?").bind(slot.slot_id).run();
   return reply({success:true,message:"Entry recorded",record_id:x.meta.last_row_id,slot_number:slot.slot_number},201);
  }
  if(p==="/api/exit"&&m==="POST"){
   if(!roles(u,"admin","attendant"))return reply({success:false,message:"Access denied"},403);
   const b=await read(req),reg=String(b.registration_number||"").trim().toUpperCase();
   const r=await env.DB.prepare("SELECT pr.*,v.vehicle_type,s.slot_id,s.slot_number FROM parking_records pr JOIN vehicles v ON v.vehicle_id=pr.vehicle_id JOIN parking_slots s ON s.slot_id=pr.slot_id WHERE v.registration_number=? AND pr.exit_time IS NULL ORDER BY pr.entry_time DESC LIMIT 1").bind(reg).first();
   if(!r)return reply({success:false,message:"Active parking record not found"},404);
   const rate=await env.DB.prepare("SELECT * FROM parking_rates WHERE vehicle_type=?").bind(r.vehicle_type).first();
   if(!rate)return reply({success:false,message:"Configure parking rates first"},409);
   const mins=Math.max(1,Math.ceil((Date.now()-new Date(r.entry_time.replace(" ","T")+"Z").getTime())/60000)),hrs=mins/60;
   const fee=hrs<=6?rate.slab_6_hours:hrs<=12?rate.slab_12_hours:Math.ceil(hrs/24)*rate.slab_24_hours;
   const pay=b.payment_status==="paid"?"paid":"pending";
   await env.DB.batch([env.DB.prepare("UPDATE parking_records SET exit_time=CURRENT_TIMESTAMP,duration_minutes=?,total_fee=?,payment_status=? WHERE record_id=?").bind(mins,fee,pay,r.record_id),env.DB.prepare("UPDATE parking_slots SET status='available' WHERE slot_id=?").bind(r.slot_id)]);
   return reply({success:true,message:"Exit recorded and slot released",slot_number:r.slot_number,duration_minutes:mins,total_fee:fee,payment_status:pay});
  }
  if(p==="/api/history"){const q="%"+(url.searchParams.get("q")||"")+"%";const r=await env.DB.prepare("SELECT pr.*,v.registration_number,v.vehicle_type,s.slot_number FROM parking_records pr JOIN vehicles v ON v.vehicle_id=pr.vehicle_id JOIN parking_slots s ON s.slot_id=pr.slot_id WHERE v.registration_number LIKE ? ORDER BY pr.entry_time DESC LIMIT 250").bind(q).all();return reply({success:true,records:r.results});}
  if(p==="/api/users"&&m==="GET"){if(!roles(u,"admin"))return reply({success:false,message:"Admin only"},403);const r=await env.DB.prepare("SELECT user_id,full_name,username,role,created_at FROM users ORDER BY user_id").all();return reply({success:true,users:r.results});}
  if(p==="/api/users"&&m==="POST"){if(!roles(u,"admin"))return reply({success:false,message:"Admin only"},403);const b=await read(req);if(!b.full_name||!b.username||!b.password||!["admin","attendant"].includes(b.role))return reply({success:false,message:"Complete all fields"},400);try{await env.DB.prepare("INSERT INTO users(full_name,username,password,role) VALUES(?,?,?,?)").bind(b.full_name,b.username,b.password,b.role).run();return reply({success:true,message:"User created"});}catch{return reply({success:false,message:"Username already exists"},409);}}
  return reply({success:false,message:"Route not found"},404);
 }catch(e){console.error(e);return reply({success:false,message:"Server error"},500);}
}};
