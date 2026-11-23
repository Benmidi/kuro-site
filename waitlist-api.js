const waitlistEndpoint='https://rqirmprdejkkfvzhttco.supabase.co/functions/v1/kuro-waitlist';
export async function requestWaitlist(payload) {
  const response=await fetch(waitlistEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(35000)});
  if(!response.ok){
    if(response.status===429)throw Error('A few too many attempts. Please try again in an hour.');
    if(response.status===400)throw Error('Please check your email address and try again.');
    throw Error('We couldn’t finish your request. Please try again in a moment.');
  }
  const data=await response.json();
  if(data.ok!==true)throw Error('Your request wasn’t saved. Please try again.');
  return data;
}
