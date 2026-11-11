const $ = (selector) => document.querySelector(selector);
$('#waitlist-form [type=submit]').disabled = false;
const waitlistEndpoint='https://rqirmprdejkkfvzhttco.supabase.co/functions/v1/kuro-waitlist';
async function requestWaitlist(payload) {
  const response=await fetch(waitlistEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
  if(!response.ok){
    if(response.status===429)throw Error('A few too many attempts. Please try again in an hour.');
    if(response.status===400)throw Error('Please check your email address and try again.');
    throw Error('We couldn’t reach the list. Please try again in a moment.');
  }
  const data=await response.json();
  if(data.ok!==true)throw Error('Your request wasn’t saved. Please try again.');
}
$('#waitlist-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.currentTarget, button=form.querySelector('[type=submit]'), status=$('#form-status');
  if(button.disabled)return;
  button.disabled=true; status.textContent='Saving your spot…'; status.dataset.error='false';
  const data=new FormData(form);
  try{
    await requestWaitlist({email:String(data.get('email')).trim(),platform:data.get('platform'),website:data.get('website'),action:'join'});
    status.textContent='You’re in. We’ll be in touch.';
    form.reset();
  }catch(error){status.textContent=error.message;status.dataset.error='true';}
  finally{button.disabled=false;}
});
const dialog=$('#privacy-dialog');
$('#privacy-open').addEventListener('click',()=>dialog.showModal());
$('#privacy-close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
$('#removal-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.currentTarget.querySelector('button'),status=$('#removal-status');
  if(button.disabled)return;
  button.disabled=true;status.dataset.error='false';status.textContent='Removing…';
  try{
    await requestWaitlist({email:$('#removal-email').value.trim(),action:'remove'});
    status.textContent='If that address was on the list, it has been removed.';
    $('#form-status').textContent='';
    event.target.reset();
  }catch(error){status.textContent=error.message;status.dataset.error='true';}
  finally{button.disabled=false;}
});

