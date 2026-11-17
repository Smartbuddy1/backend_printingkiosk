"use strict";
const en = {
  back: "Back",
  launchDescription: "Choose documents from your digital locker and print them here.", launchAction: "Choose documents",
  title: "DigiLocker", scan: "Scan", login: "Log in on your phone", choose: "Choose documents", print: "Print",
  heading: "Print from DigiLocker", instructions: "Scan this QR code with your phone. Sign in to DigiLocker and choose the documents you want to print.",
  phoneConnected: "Phone connected. Continue on your phone.", downloading: "Receiving your selected documents…", ready: "Your documents are ready",
  privacy: "Your documents are printed and then deleted immediately", confirm: "Confirm & Print", continueNote: "Next: preview, print settings and payment.",
  refresh: "Refresh QR", cancel: "Cancel", home: "Back to home", timeLeft: "Time remaining", starting: "Preparing a secure connection…",
  done: "Printing complete", deleted: "Your documents have been deleted.", failed: "We could not complete this print", ended: "This session has ended. Start again at the kiosk.",
  denied: "Access was declined. No documents were sent.", retry: "Please start again at the kiosk.", generic: "We could not complete this request. Please try again at the kiosk.",
  selectTitle: "Choose documents to print", selectIntro: "Select only the documents you want to send to this kiosk.", send: "Send to kiosk",
  selected: "selected", max: "Maximum", files: "documents", pages: "pages", sent: "Documents sent", sentNote: "Your selected documents are opening on the kiosk now.",
  noDocuments: "No printable PDF, JPG or PNG documents were shared. Please start again and check your consent.",
  logout: "Log out of DigiLocker", consent: "Your DigiLocker login stays on your phone.", issuer: "Issuer", type: "Type", date: "Date",
  mock: "Local test · sample documents only", mockAccount: "Use the sample account to test login and consent. Do not enter personal details.",
  allow: "Sign in & allow sample documents", deny: "Decline", mockPrint: "Local preview: payment and printing are simulated. No money is charged and no paper is printed.",
  paymentMock: "Test payment", paymentMockNote: "Use Payment Done below to simulate a successful payment.",
  unavailable: "DigiLocker is unavailable. Please try again.", cleanup: "Finishing securely…", copied: "Document", link: "Open phone page", printFailed: "Printing failed. Your documents were deleted; ask staff for help before starting again.",
  INTEGRITY_FAILED: "A document failed its integrity check. Nothing was sent to the kiosk.",
  FILE_TOO_LARGE: "A selected document is too large.", FILE_TYPE_INVALID: "Only valid PDF, JPG and PNG documents can be printed.",
  PAGE_LIMIT: "A selected document exceeds the kiosk's 10-page limit.", PDF_INVALID: "A PDF is damaged or password protected and cannot be printed.",
  CONSENT_REQUIRED: "The requested documents were not included in your consent. Please start again.", TOKEN_EXPIRED: "Your authorization has expired. Please start again.",
  DOCUMENT_UNAVAILABLE: "A selected document is no longer available. Please start again.", RATE_LIMITED: "Please wait a moment before trying again.",
  BUSY: "The kiosk is busy. Please wait a moment and try again.", REVOKE_FAILED: "The connection could not be closed with DigiLocker. Please log out on your phone and start again."
};
const hi = {
  back: "\u0935\u093e\u092a\u0938",
  title:"DigiLocker", scan:"स्कैन करें", login:"फ़ोन पर लॉग इन करें", choose:"दस्तावेज़ चुनें", print:"प्रिंट करें", heading:"DigiLocker से प्रिंट करें",
  instructions:"अपने फ़ोन से यह QR कोड स्कैन करें। DigiLocker में लॉग इन करके प्रिंट करने के लिए दस्तावेज़ चुनें।",
  phoneConnected:"फ़ोन जुड़ गया है। अपने फ़ोन पर आगे बढ़ें।", downloading:"आपके चुने हुए दस्तावेज़ प्राप्त हो रहे हैं…", ready:"आपके दस्तावेज़ तैयार हैं",
  privacy:"प्रिंट होने के तुरंत बाद आपके दस्तावेज़ हटा दिए जाते हैं", confirm:"पुष्टि करें और प्रिंट करें", continueNote:"अगला चरण: पूर्वावलोकन, प्रिंट सेटिंग और भुगतान।",
  refresh:"नया QR कोड", cancel:"रद्द करें", home:"होम पर जाएँ", timeLeft:"शेष समय", starting:"सुरक्षित कनेक्शन तैयार हो रहा है…",
  done:"प्रिंट पूरा हुआ", deleted:"आपके दस्तावेज़ हटा दिए गए हैं।", failed:"प्रिंट पूरा नहीं हो सका", ended:"यह सत्र समाप्त हो गया है। कियोस्क पर फिर शुरू करें।",
  denied:"अनुमति नहीं दी गई। कोई दस्तावेज़ नहीं भेजा गया।", retry:"कृपया कियोस्क पर फिर शुरू करें।", generic:"यह अनुरोध पूरा नहीं हो सका। कियोस्क पर फिर प्रयास करें।",
  selectTitle:"प्रिंट करने के लिए दस्तावेज़ चुनें", selectIntro:"केवल वे दस्तावेज़ चुनें जिन्हें आप इस कियोस्क पर भेजना चाहते हैं।", send:"कियोस्क पर भेजें",
  selected:"चुने गए", max:"अधिकतम", files:"दस्तावेज़", pages:"पृष्ठ", sent:"दस्तावेज़ भेज दिए गए", sentNote:"आपके चुने हुए दस्तावेज़ अब कियोस्क पर खुल रहे हैं।",
  noDocuments:"कोई प्रिंट करने योग्य PDF, JPG या PNG साझा नहीं किया गया। फिर शुरू करें और अनुमति जाँचें।", logout:"DigiLocker से लॉग आउट करें",
  consent:"DigiLocker में लॉग इन केवल आपके फ़ोन पर होता है।", issuer:"जारीकर्ता", type:"प्रकार", date:"तारीख",
  mock:"स्थानीय परीक्षण · केवल नमूना दस्तावेज़", mockAccount:"लॉग इन और अनुमति का परीक्षण नमूना खाते से करें। निजी जानकारी दर्ज न करें।",
  allow:"नमूना दस्तावेज़ों की अनुमति दें", deny:"अनुमति न दें", mockPrint:"स्थानीय पूर्वावलोकन: भुगतान और प्रिंट का अनुकरण है। कोई पैसा नहीं कटेगा और कोई कागज़ प्रिंट नहीं होगा।",
  paymentMock:"परीक्षण भुगतान", paymentMockNote:"सफल भुगतान का अनुकरण करने के लिए नीचे Payment Done दबाएँ।", unavailable:"DigiLocker उपलब्ध नहीं है। फिर प्रयास करें।",
  cleanup:"सुरक्षित रूप से पूरा हो रहा है…", copied:"दस्तावेज़", link:"फ़ोन पेज खोलें", printFailed:"प्रिंट विफल हुआ। दस्तावेज़ हटा दिए गए हैं। फिर शुरू करने से पहले कर्मचारियों से मदद लें।"
};
const mr = {
  back: "\u092e\u093e\u0917\u0947",
  title:"DigiLocker", scan:"स्कॅन करा", login:"फोनवर लॉग इन करा", choose:"कागदपत्रे निवडा", print:"प्रिंट करा", heading:"DigiLocker मधून प्रिंट करा",
  instructions:"तुमच्या फोनने हा QR कोड स्कॅन करा. DigiLocker मध्ये लॉग इन करून प्रिंटसाठी कागदपत्रे निवडा.",
  phoneConnected:"फोन जोडला आहे. फोनवर पुढे जा.", downloading:"निवडलेली कागदपत्रे मिळत आहेत…", ready:"तुमची कागदपत्रे तयार आहेत",
  privacy:"प्रिंट झाल्यावर तुमची कागदपत्रे लगेच हटवली जातात", confirm:"पुष्टी करा आणि प्रिंट करा", continueNote:"पुढे: पूर्वावलोकन, प्रिंट सेटिंग आणि पेमेंट.",
  refresh:"नवीन QR कोड", cancel:"रद्द करा", home:"मुख्यपृष्ठावर जा", timeLeft:"उरलेला वेळ", starting:"सुरक्षित जोडणी तयार होत आहे…",
  done:"प्रिंट पूर्ण झाले", deleted:"तुमची कागदपत्रे हटवली आहेत.", failed:"प्रिंट पूर्ण होऊ शकले नाही", ended:"हे सत्र संपले आहे. कियोस्कवर पुन्हा सुरू करा.",
  denied:"परवानगी नाकारली. कोणतीही कागदपत्रे पाठवली नाहीत.", retry:"कृपया कियोस्कवर पुन्हा सुरू करा.", generic:"विनंती पूर्ण झाली नाही. कृपया कियोस्कवर पुन्हा प्रयत्न करा.",
  selectTitle:"प्रिंटसाठी कागदपत्रे निवडा", selectIntro:"या कियोस्कवर पाठवायची कागदपत्रेच निवडा.", send:"कियोस्कवर पाठवा",
  selected:"निवडलेली", max:"कमाल", files:"कागदपत्रे", pages:"पाने", sent:"कागदपत्रे पाठवली", sentNote:"तुमची निवडलेली कागदपत्रे आता कियोस्कवर उघडत आहेत.",
  noDocuments:"प्रिंट करता येणारी PDF, JPG किंवा PNG कागदपत्रे सामायिक केलेली नाहीत. पुन्हा सुरू करून परवानगी तपासा.", logout:"DigiLocker मधून लॉग आउट करा",
  consent:"DigiLocker मध्ये लॉग इन फक्त तुमच्या फोनवर होते.", issuer:"जारीकर्ता", type:"प्रकार", date:"तारीख",
  mock:"स्थानिक चाचणी · फक्त नमुना कागदपत्रे", mockAccount:"लॉग इन आणि परवानगी तपासण्यासाठी नमुना खाते वापरा. वैयक्तिक माहिती देऊ नका.",
  allow:"नमुना कागदपत्रांना परवानगी द्या", deny:"नकार द्या", mockPrint:"स्थानिक पूर्वावलोकन: पेमेंट आणि प्रिंटचे अनुकरण आहे. पैसे आकारले जाणार नाहीत आणि कागद प्रिंट होणार नाही.",
  paymentMock:"चाचणी पेमेंट", paymentMockNote:"यशस्वी पेमेंटचे अनुकरण करण्यासाठी खाली Payment Done दाबा.", unavailable:"DigiLocker उपलब्ध नाही. पुन्हा प्रयत्न करा.",
  cleanup:"सुरक्षितपणे पूर्ण होत आहे…", copied:"कागदपत्र", link:"फोन पान उघडा", printFailed:"प्रिंट अयशस्वी. कागदपत्रे हटवली आहेत. पुन्हा सुरू करण्यापूर्वी कर्मचाऱ्यांची मदत घ्या."
};
Object.assign(hi, {
  INTEGRITY_FAILED:"दस्तावेज़ की सुरक्षा जाँच विफल हुई। कोई दस्तावेज़ नहीं भेजा गया।",
  FILE_TOO_LARGE:"चुना हुआ दस्तावेज़ बहुत बड़ा है।", FILE_TYPE_INVALID:"केवल मान्य PDF, JPG और PNG प्रिंट किए जा सकते हैं।",
  PAGE_LIMIT:"चुने हुए दस्तावेज़ में 10 से अधिक पृष्ठ हैं।", PDF_INVALID:"PDF खराब है या पासवर्ड से सुरक्षित है।",
  CONSENT_REQUIRED:"चुने हुए दस्तावेज़ों की अनुमति नहीं मिली। कृपया फिर शुरू करें।", TOKEN_EXPIRED:"आपकी अनुमति समाप्त हो गई है। फिर शुरू करें।",
  DOCUMENT_UNAVAILABLE:"चुना हुआ दस्तावेज़ अब उपलब्ध नहीं है। फिर शुरू करें।", RATE_LIMITED:"दोबारा प्रयास करने से पहले थोड़ा रुकें।",
  BUSY:"कियोस्क व्यस्त है। थोड़ी देर बाद प्रयास करें।", REVOKE_FAILED:"DigiLocker कनेक्शन बंद नहीं हो सका। फ़ोन पर लॉग आउट करके फिर शुरू करें।"
});
Object.assign(mr, {
  INTEGRITY_FAILED:"कागदपत्राची सुरक्षा तपासणी अयशस्वी झाली. कोणतेही कागदपत्र पाठवले नाही.",
  FILE_TOO_LARGE:"निवडलेले कागदपत्र खूप मोठे आहे.", FILE_TYPE_INVALID:"फक्त वैध PDF, JPG आणि PNG प्रिंट करता येतात.",
  PAGE_LIMIT:"निवडलेल्या कागदपत्रात 10 पेक्षा जास्त पाने आहेत.", PDF_INVALID:"PDF खराब आहे किंवा पासवर्डने सुरक्षित आहे.",
  CONSENT_REQUIRED:"निवडलेल्या कागदपत्रांना परवानगी मिळाली नाही. पुन्हा सुरू करा.", TOKEN_EXPIRED:"तुमची परवानगी संपली आहे. पुन्हा सुरू करा.",
  DOCUMENT_UNAVAILABLE:"निवडलेले कागदपत्र आता उपलब्ध नाही. पुन्हा सुरू करा.", RATE_LIMITED:"पुन्हा प्रयत्न करण्यापूर्वी थोडा वेळ थांबा.",
  BUSY:"किओस्क व्यस्त आहे. थोड्या वेळाने प्रयत्न करा.", REVOKE_FAILED:"DigiLocker कनेक्शन बंद करता आले नाही. फोनवर लॉग आउट करून पुन्हा सुरू करा."
});
for (const d of [en,hi,mr]) {
  for (const key of ["SESSION_ENDED","PAIR_INVALID","STATE_INVALID"]) d[key]=d.ended;
  for (const key of ["NOT_AUTHORIZED","SELECTION_INVALID","REQUEST_INVALID","INTERNAL_ERROR"]) d[key]=d.generic;
  d.PROVIDER_UNAVAILABLE=d.unavailable; d.IMAGE_TOO_LARGE=d.FILE_TOO_LARGE;
}
const dictionaries = { en, hi: { ...en, ...hi }, mr: { ...en, ...mr } };
dictionaries.en.DIGILOCKER_NOT_READY = "DigiLocker is not available yet. Please use file upload.";
dictionaries.hi.DIGILOCKER_NOT_READY = "DigiLocker अभी उपलब्ध नहीं है। कृपया फ़ाइल अपलोड का उपयोग करें।";
dictionaries.mr.DIGILOCKER_NOT_READY = "DigiLocker अद्याप उपलब्ध नाही. कृपया फाइल अपलोड वापरा.";
function translator(language) { const d = dictionaries[language] || en; return key => d[key] || d.generic; }
Object.assign(dictionaries.en, { DIGILOCKER_KIOSK_DISABLED: "DigiLocker is not enabled for this kiosk. Please use file upload.", DIGILOCKER_KIOSK_UNAVAILABLE: "Cannot check this kiosk's DigiLocker setting. Please try again." });
Object.assign(dictionaries.hi, { DIGILOCKER_KIOSK_DISABLED: "इस कियोस्क पर DigiLocker चालू नहीं है। कृपया फ़ाइल अपलोड करें।", DIGILOCKER_KIOSK_UNAVAILABLE: "कियोस्क की DigiLocker सेटिंग जाँची नहीं जा सकी। कृपया फिर कोशिश करें।" });
Object.assign(dictionaries.mr, { DIGILOCKER_KIOSK_DISABLED: "या किऑस्कवर DigiLocker सुरू नाही. कृपया फाइल अपलोड करा.", DIGILOCKER_KIOSK_UNAVAILABLE: "किऑस्कची DigiLocker सेटिंग तपासता आली नाही. कृपया पुन्हा प्रयत्न करा." });
Object.assign(dictionaries.en, { connectionFailed: "DigiLocker connection could not be opened", confirm: "Continue to preview" });
Object.assign(dictionaries.hi, { connectionFailed: "DigiLocker कनेक्शन नहीं खुल सका", confirm: "पूर्वावलोकन पर जाएँ" });
Object.assign(dictionaries.mr, { connectionFailed: "DigiLocker जोडणी उघडता आली नाही", confirm: "पूर्वावलोकनाकडे जा" });
Object.assign(dictionaries.en,{
  passwordTitle:"Open your protected PDF",passwordIntro:"This document needs its PDF opening password. Enter it to continue to the kiosk preview.",passwordLabel:"PDF password",passwordPrivacy:"Use the document password, not your DigiLocker PIN or OTP. It is used only for this request and is not saved.",passwordContinue:"Unlock and continue",
  PDF_PASSWORD_REQUIRED:"This PDF needs its opening password.",PDF_PASSWORD_INCORRECT:"That password did not open the PDF. Check it and try again.",PDF_UNLOCK_FAILED:"This PDF could not be opened. Start again or choose another document.",PDF_UNLOCK_UNAVAILABLE:"Password-protected PDFs are not available right now. Please choose another document.",PDF_INVALID:"This PDF could not be read for printing. Please try another document."
});
Object.assign(dictionaries.hi,{
  passwordTitle:"पासवर्ड वाला PDF खोलें",passwordIntro:"इस दस्तावेज़ को खोलने के लिए उसका PDF पासवर्ड डालें।",passwordLabel:"PDF पासवर्ड",passwordPrivacy:"दस्तावेज़ का पासवर्ड डालें, DigiLocker PIN या OTP नहीं। पासवर्ड केवल इस अनुरोध के लिए उपयोग होगा और सेव नहीं होगा।",passwordContinue:"खोलें और आगे बढ़ें",
  PDF_PASSWORD_REQUIRED:"इस PDF को खोलने के लिए पासवर्ड चाहिए।",PDF_PASSWORD_INCORRECT:"इस पासवर्ड से PDF नहीं खुला। जाँच करके फिर कोशिश करें।",PDF_UNLOCK_FAILED:"PDF नहीं खुल सका। फिर शुरू करें या दूसरा दस्तावेज़ चुनें।",PDF_UNLOCK_UNAVAILABLE:"अभी पासवर्ड वाले PDF उपलब्ध नहीं हैं। दूसरा दस्तावेज़ चुनें।",PDF_INVALID:"यह PDF प्रिंट के लिए पढ़ा नहीं जा सका। दूसरा दस्तावेज़ चुनें।"
});
Object.assign(dictionaries.mr,{
  passwordTitle:"पासवर्ड असलेला PDF उघडा",passwordIntro:"हा दस्तऐवज उघडण्यासाठी त्याचा PDF पासवर्ड टाका.",passwordLabel:"PDF पासवर्ड",passwordPrivacy:"दस्तऐवजाचा पासवर्ड टाका, DigiLocker PIN किंवा OTP नाही. पासवर्ड फक्त या विनंतीसाठी वापरला जाईल आणि साठवला जाणार नाही.",passwordContinue:"उघडा आणि पुढे जा",
  PDF_PASSWORD_REQUIRED:"हा PDF उघडण्यासाठी पासवर्ड आवश्यक आहे.",PDF_PASSWORD_INCORRECT:"या पासवर्डने PDF उघडला नाही. तपासून पुन्हा प्रयत्न करा.",PDF_UNLOCK_FAILED:"PDF उघडता आला नाही. पुन्हा सुरू करा किंवा दुसरा दस्तऐवज निवडा.",PDF_UNLOCK_UNAVAILABLE:"सध्या पासवर्ड असलेले PDF उपलब्ध नाहीत. दुसरा दस्तऐवज निवडा.",PDF_INVALID:"हा PDF छपाईसाठी वाचता आला नाही. दुसरा दस्तऐवज निवडा."
});
Object.assign(dictionaries.en, {
  "scanPhoneTitle": "Scan with your phone",
  "scanPhoneHint": "Use your phone camera to scan this code.",
  "waitingForScan": "Waiting for phone scan",
  "scanPhoneLead": "Sign in on your phone, choose the documents you want to print, then send them securely to this kiosk.",
  "scanPhoneStep": "Scan this QR code with your phone camera.",
  "signInStep": "Sign in to DigiLocker on your phone.",
  "selectDocumentsStep": "Select the available documents you want to print, such as Aadhaar, PAN card or marksheet.",
  "sendStep": "Tap Send to kiosk. Your selected documents will open here automatically.",
  "phoneConnectedTitle": "Connected to DigiLocker",
  "phoneConnectedHint": "Continue securely on your phone and choose the documents you want to print.",
  "receivingTitle": "Bringing your documents to the kiosk",
  "receivingHint": "Your selected documents are being securely prepared for preview.",
  "automaticPreviewNote": "The full selected set will open in preview automatically.",
  "sentNote": "Your selected documents are opening on the kiosk now."
});
Object.assign(dictionaries.hi, {
  "scanPhoneTitle": "अपने फ़ोन से स्कैन करें",
  "scanPhoneHint": "अपने फ़ोन के कैमरे से यह QR कोड स्कैन करें।",
  "waitingForScan": "फ़ोन से स्कैन करने की प्रतीक्षा",
  "scanPhoneLead": "फ़ोन पर लॉग इन करें, दस्तावेज़ चुनें और इस कियोस्क पर भेजें।",
  "scanPhoneStep": "फ़ोन के कैमरे से QR कोड स्कैन करें।",
  "signInStep": "अपने फ़ोन पर DigiLocker में लॉग इन करें।",
  "selectDocumentsStep": "उपलब्ध दस्तावेज़ चुनें, जैसे आधार, PAN कार्ड या मार्कशीट।",
  "sendStep": "कियोस्क पर भेजें दबाएँ। चुने हुए दस्तावेज़ यहाँ अपने आप खुलेंगे।",
  "phoneConnectedTitle": "DigiLocker से जुड़ गए हैं",
  "phoneConnectedHint": "अपने फ़ोन पर आगे बढ़ें और प्रिंट करने के लिए दस्तावेज़ चुनें।",
  "receivingTitle": "आपके दस्तावेज़ कियोस्क पर आ रहे हैं",
  "receivingHint": "चुने हुए दस्तावेज़ पूर्वावलोकन के लिए तैयार हो रहे हैं।",
  "automaticPreviewNote": "सभी चुने हुए दस्तावेज़ एक साथ अपने आप खुलेंगे।",
  "sentNote": "आपके चुने हुए दस्तावेज़ अब कियोस्क पर खुल रहे हैं।"
});
Object.assign(dictionaries.mr, {
  "scanPhoneTitle": "तुमच्या फोनने स्कॅन करा",
  "scanPhoneHint": "फोनच्या कॅमेऱ्याने हा QR कोड स्कॅन करा.",
  "waitingForScan": "फोनने स्कॅन करण्याची प्रतीक्षा",
  "scanPhoneLead": "फोनवर लॉग इन करा, कागदपत्रे निवडा आणि या कियोस्कवर पाठवा.",
  "scanPhoneStep": "फोनच्या कॅमेऱ्याने QR कोड स्कॅन करा.",
  "signInStep": "तुमच्या फोनवर DigiLocker मध्ये लॉग इन करा.",
  "selectDocumentsStep": "उपलब्ध कागदपत्रे निवडा, जसे आधार, PAN कार्ड किंवा गुणपत्रिका.",
  "sendStep": "कियोस्कवर पाठवा दाबा. निवडलेली कागदपत्रे येथे आपोआप उघडतील.",
  "phoneConnectedTitle": "DigiLocker शी जोडले आहे",
  "phoneConnectedHint": "फोनवर पुढे जा आणि प्रिंट करायची कागदपत्रे निवडा.",
  "receivingTitle": "तुमची कागदपत्रे कियोस्कवर येत आहेत",
  "receivingHint": "निवडलेली कागदपत्रे पूर्वावलोकनासाठी तयार होत आहेत.",
  "automaticPreviewNote": "सर्व निवडलेली कागदपत्रे एकत्र आपोआप उघडतील.",
  "sentNote": "तुमची निवडलेली कागदपत्रे आता कियोस्कवर उघडत आहेत."
});
module.exports = { dictionaries, translator };
