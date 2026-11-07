# 💇‍♀️ Glow & Co. Salon — AI Phone & Web Receptionist

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Vercel-black?style=for-the-badge&logo=vercel)](https://bluemoonways-ai-salon.vercel.app/)
[![Vapi AI](https://img.shields.io/badge/Voice%20AI-Vapi.ai-purple?style=for-the-badge)](https://vapi.ai)
[![Google Apps Script](https://img.shields.io/badge/Backend-Google%20Apps%20Script-green?style=for-the-badge&logo=google)](https://script.google.com)

An intelligent, end-to-end **AI Phone Receptionist & Web Voice Assistant** designed for beauty salons, barber shops, and spas. It handles incoming voice calls and web-based voice interactions 24/7—booking appointments, checking real-time availability, answering service FAQs, and triggering confirmation messages automatically.

🔗 **Live Website Demo:** [https://bluemoonways-ai-salon.vercel.app/](https://bluemoonways-ai-salon.vercel.app/)

---

## 🌟 Key Features

* 📞 **24/7 Voice AI Receptionist:** Answers customer voice calls and interactive web calls with natural, human-like voice responses.
* 📅 **Smart Appointment Management:** Books, reschedules, and cancels client slots dynamically.
* 🔄 **Real-Time Availability Checks:** Queries Google Sheets / Calendar to prevent double-booking.
* 📲 **Automated Confirmations:** Triggers SMS/WhatsApp notification updates and reminders.
* 💈 **Dynamic Service & FAQ Guidance:** Answers questions regarding salon services, pricing, operating hours, and location.
* 👤 **Human Escalation:** Smoothly forwards complex queries or complaints to human salon managers.

---

## 🏗️ System Architecture

```text
[ Web Client / Phone Caller ] 
             │
      (Voice Stream)
             ▼
      [ Vapi.ai Agent ] ──(Custom Tools Webhook)──► [ Google Apps Script ]
                                                            │
                                                   ┌────────┴────────┐
                                                   ▼                 ▼
                                          [ Google Sheets ]   [ Twilio SMS / WhatsApp ]
```

* **Frontend:** Responsive HTML5, Tailwind CSS, JavaScript (Deployed on Vercel)
* **Voice Engine:** [Vapi.ai](https://vapi.ai) (Speech-to-Text, LLM Processing, Text-to-Speech)
* **Backend Endpoint:** Google Apps Script Web App
* **Database & Scheduling:** Google Sheets / Google Calendar API
* **Notification System:** Twilio SMS / WhatsApp Business API

---

## 📁 Repository Structure

```text
Salon-AI-Receptionist/
├── Landing_page/         # Web landing page & live call interface (Deployed to Vercel)
│   └── index.html        # Main interface with embedded Vapi Web SDK
├── Vapi/                 # Vapi AI agent settings, system prompts, and tool schemas
│   └── assistant.json    # Complete Vapi agent setup configuration
├── apps-script/          # Serverless Google Apps Script backend
│   └── Code.gs           # Webhook handler for availability, booking, & notifications
├── .gitignore
├── README.md             # Project documentation
└── SETUP.md              # Detailed step-by-step setup guide
```

---

## ⚡ Quick Setup Guide

### 1. Backend Setup (Google Apps Script)
1. Create a Google Sheet with columns for logging reservations: `Name`, `Phone`, `Service`, `Date`, `Time`, `Status`.
2. Open **Extensions > Apps Script** and paste the code from `apps-script/Code.gs`.
3. Deploy as a **Web App** (*Execute as: Me*, *Who has access: Anyone*).
4. Copy the Web App Deployment URL.

### 2. Voice Agent Configuration (Vapi.ai)
1. Import the JSON configuration from `Vapi/assistant.json` into your Vapi Dashboard.
2. Link the custom function tools to your Google Apps Script Web App URL.
3. Attach your phone number (via Twilio/Vapi) to the assistant.

### 3. Frontend Deployment (Vercel)
1. Configure your **Vapi Public Key** and **Assistant ID** in `Landing_page/index.html`.
2. Push your code to GitHub and connect the repository to Vercel for automatic deployment.

---

## 👨‍💻 Author

**Faheem Abbas (bluemoonways)**  
*AI Automation Developer & AI Specialist*  
* GitHub: [@bluemoonways](https://github.com/bluemoonways)  
* Live Project: [bluemoonways-ai-salon.vercel.app](https://bluemoonways-ai-salon.vercel.app/)
