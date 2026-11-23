import { requestWaitlist } from './waitlist-api.js';
const $ = (selector) => document.querySelector(selector);
$('#waitlist-form [type=submit]').disabled = false;
$('#waitlist-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.currentTarget, button=form.querySelector('[type=submit]'), status=$('#form-status');
  if(button.disabled)return;
  button.disabled=true; status.textContent='Sending your invitation…'; status.dataset.error='false';
  const links=$('#beta-links');
  links.hidden=true;
  const data=new FormData(form);
  try{
    const result=await requestWaitlist({email:String(data.get('email')).trim(),platform:data.get('platform'),website:data.get('website'),action:'join'});
    if(result.delivery==='unconfigured'){
      status.textContent='You’re on the list. Email delivery is being set up. You can use the beta links here.';
      links.hidden=false;
    }else status.textContent='Check your inbox for your KURO beta invitation. If you signed up before, look for the original email.';
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

