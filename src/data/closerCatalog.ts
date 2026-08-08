/**
 * Closer Mode catalog — hundreds of random products, customer names,
 * hidden personas and moods. Helpers avoid repeating recent picks so
 * back-to-back calls always feel fresh.
 */

export const PRODUCTS: string[] = [
  "Car", "Phone", "Laptop", "Keyboard", "Mouse", "Gaming Chair", "Bottle", "Coffee", "Mug",
  "Pen", "Shoes", "Water Bottle", "Protein Powder", "Gym Membership", "Chocolate", "Insurance",
  "Netflix Subscription", "House", "Vacuum Cleaner", "Drone", "Backpack", "Headphones", "Speaker",
  "Sunglasses", "Notebook", "Chair", "Table", "Smart Watch", "Keyboard Cleaner", "Camera",
  "Printer", "Toothbrush", "Electric Scooter", "Coffee Machine", "Air Fryer", "Pizza", "Burger",
  "Watch", "Perfume", "Soap", "Water Filter", "Car Wash", "Travel Package", "Course", "Dog Toy",
  "Cat Food", "Electric Fan", "Vacuum", "Mirror", "Jacket", "Book", "Umbrella", "Plant",
  "Candle", "Monitor", "SSD", "Graphics Card", "Microphone", "Ring Light", "Webcam", "Tablet",
  "Router", "Mattress", "Pillow", "Mattress Protector", "Water Purifier", "Hair Dryer",
  "Blender", "Toaster", "Juicer", "Standing Desk", "Ergonomic Mouse", "Mechanical Keyboard",
  "Laptop Stand", "Phone Case", "Screen Protector", "Power Bank", "Wireless Charger",
  "Car Phone Mount", "Dash Cam", "Tire Inflator", "Jump Starter", "Smart Lock",
  "Video Doorbell", "Security Camera", "Robot Vacuum", "Air Purifier", "Humidifier", "Heater",
  "Electric Blanket", "Massage Gun", "Foam Roller", "Resistance Bands", "Dumbbells",
  "Treadmill", "Exercise Bike", "Rowing Machine", "Yoga Mat", "Kettlebell", "Weight Bench",
  "Pull-Up Bar", "Fitness Tracker", "Lunch Box", "Food Container", "Pressure Cooker",
  "Rice Cooker", "Slow Cooker", "Bread Maker", "Waffle Maker", "Sandwich Maker",
  "Electric Grill", "Espresso Machine", "French Press", "Milk Frother", "Tea Kettle",
  "Insulated Travel Mug", "Thermos", "Wine Aerator", "Corkscrew", "Knife Set",
  "Cutting Board", "Pan Set", "Pot Set", "Meat Thermometer", "Garlic Press",
  "Vegetable Chopper", "Spiralizer", "Salad Spinner", "Ice Cream Maker", "Soda Maker",
  "Popcorn Maker", "Crepe Maker", "Egg Cooker", "Food Scale", "Sous Vide",
  "Cast Iron Skillet", "Carbon Steel Pan", "Dutch Oven", "Chef's Knife", "Paring Knife",
  "Bread Knife", "Grill Brush", "BBQ Tool Set", "Smoker", "Pellet Grill", "Camping Tent",
  "Sleeping Bag", "Camping Stove", "Hiking Backpack", "Headlamp", "Hiking Boots",
  "Trekking Poles", "First Aid Kit", "Swiss Army Knife", "Multi-tool", "Flashlight",
  "Lantern", "Portable Power Station", "Solar Charger", "Bicycle", "Electric Bike",
  "Scooter", "Helmet", "Bike Lock", "Bike Pump", "Bike Lights", "Golf Clubs", "Golf Balls",
  "Tennis Racket", "Soccer Ball", "Basketball", "Table Tennis Set", "Pool Table",
  "Dartboard", "Foosball Table", "VR Headset", "Game Controller", "Gaming Console",
  "Gaming PC", "Gaming Monitor", "Capture Card", "Studio Headphones", "MIDI Keyboard",
  "Digital Piano", "Guitar", "Ukulele", "Drum Kit", "DJ Controller", "Turntable",
  "Karaoke Machine", "Home Theater", "Soundbar", "Projector", "Subwoofer",
  "Record Player", "E-Book Reader", "Drawing Tablet", "Stylus Pen", "3D Printer",
  "Laser Engraver", "Soldering Iron", "Multimeter", "Drill", "Circular Saw", "Jigsaw",
  "Sander", "Screwdriver Set", "Wrench Set", "Socket Set", "Tool Box", "Tool Chest",
  "Workbench", "Ladder", "Tape Measure", "Stud Finder", "Paint Sprayer", "Leaf Blower",
  "Lawn Mower", "Hedge Trimmer", "Garden Hose", "Sprinkler", "Garden Tools", "Greenhouse",
  "Compost Bin", "Bird Feeder", "Garden Lights", "Solar Lights", "Artificial Plant",
  "Picture Frame", "Photo Album", "Scrapbook", "Craft Kit", "Sewing Machine",
  "Embroidery Kit", "Knitting Kit", "Candle Making Kit", "Soap Making Kit",
  "Essential Oil Diffuser", "Aromatherapy Set", "Salt Lamp", "Fairy Lights",
  "Bedside Lamp", "Desk Lamp", "Floor Lamp", "Smart Bulb", "Smart Plug",
  "Smart Thermostat", "Smart Speaker", "Smart Display", "Pet Camera", "Pet Feeder",
  "Pet Water Fountain", "Cat Tree", "Cat Bed", "Dog Bed", "Dog Crate", "Dog Leash",
  "Dog Collar", "Cat Litter Box", "Cat Carrier", "Bird Cage", "Fish Tank",
  "Aquarium Filter", "Dog Food", "Pet Treats", "Pet Toys", "Pet Grooming Kit",
  "Pet GPS Tracker", "Pet Bowl", "Pet Mat", "Pet Playpen", "Pet Stroller",
  // ── Business services ─────────────────────────────────────────────
  "CRM Software", "Email Marketing Platform", "Invoicing Software",
  "Payroll Service", "Bookkeeping Service", "Business Insurance",
  "Website Builder", "E-commerce Platform", "SEO Audit Service",
  "Social Media Management", "Cloud Backup Service", "Cybersecurity Assessment",
  "Team Chat Software", "Project Management Tool", "Customer Support Desk",
  "Point of Sale System", "Inventory Management", "Virtual Receptionist",
  "Commercial Cleaning", "IT Managed Services", "Fleet Management",
  "Shipping Discount Program", "Expense Management App", "HR Platform",
  "Video Meeting Hardware", "Digital Signage", "Corporate Gifting Service",
  "Employee Wellness Program", "Lead Generation Service", "Call Center Software",
  // ── Subscriptions ─────────────────────────────────────────────────
  "Streaming Bundle", "Audiobook Subscription", "Language Learning App",
  "Coding Bootcamp", "Meal Kit Delivery", "Coffee Subscription",
  "Wine Club", "Flower Delivery Subscription", "Contact Lens Subscription",
  "Vitamin Subscription", "Pet Food Delivery", "Gym App Subscription",
  "Meditation App", "Cloud Storage Plan", "VPN Subscription",
  "Domain & Hosting Bundle", "Stock Photo Subscription", "Music Lessons App",
  "Recipe App Premium", "Grocery Delivery Pass",
  // ── Food & drink ──────────────────────────────────────────────────
  "Artisan Chocolate Box", "Craft Beer Sampler", "Specialty Olive Oil",
  "Gourmet Popcorn", "Organic Tea Set", "Single-Origin Coffee Beans",
  "Hot Sauce Trio", "Honey Sampler", "Premium Jerky", "Kombucha Kit",
  "Cold Brew Maker", "Cocktail Smoker Kit", "Wine Decanter",
  "Whiskey Stones", "Beer Brewing Kit", "Cheese of the Month",
  "Truffle Salt Set", "Maple Syrup Gift", "Spice Blend Kit", "Matcha Starter Kit",
  // ── Productivity & accessories ────────────────────────────────────
  "Notion Templates", "Focus Timer", "Desk Organizer", "Cable Management Kit",
  "Standing Desk Mat", "Monitor Arm", "Laptop Sleeve", "USB-C Hub",
  "Mechanical Keyboard Kit", "Ergonomic Trackball", "Noise-Canceling Earplugs",
  "Blue-Light Glasses", "Travel Pillow", "Passport Holder", "Luggage Tags",
  "Packing Cubes", "Wireless Earbuds Case", "Phone Grip", "Cable Ties",
  "Label Maker", "Whiteboard Wall", "Smart Notebook", "Desk Calendar",
  "Focus App", "Pomodoro Timer", "Keyboard Wrist Rest", "Monitor Light Bar",
  "Webcam Cover", "Privacy Screen", "Battery Organizer",
  // ── Unusual but plausible ─────────────────────────────────────────
  "Telescope", "Metal Detector", "Indoor Garden Kit", "Hydroponic Tower",
  "Compostable Phone Case", "Smart Mug", "Self-Stirring Mug", "Egg-Boiling Machine",
  "Fruit Infuser Bottle", "Under-Desk Treadmill", "Standing Desk Converter",
  "Laptop Cooling Pad", "Solar Backpack", "Bike Phone Mount", "Action Camera",
  "Instant Film Camera", "Photo Printer", "Vinyl Record Cleaner",
  "Espresso Tamping Station", "Butter Dish with Spreader", "Garlic Rock",
  "Pasta Maker", "Pizza Oven", "Waffle Iron", "Churro Maker",
  "Boba Tea Kit", "SodaStream", "Cocktail Smoker", "Champagne Saber",
  "Fondue Set", "Raclette Grill", "Crepe Maker", "Takoyaki Pan",
  "Indoor Smoker", "Sous Vide", "Vacuum Sealer", "Fermentation Kit",
  "Kimchi Fridge", "Bread Proofing Box", "Butter Churn", "Cheese Press",
  "Beer Growler", "Mini Fridge", "Retro Toaster", "Stand Mixer",
  "Food Dehydrator", "Ice Cream Maker", "Yogurt Maker", "Espresso Grinder",
  "Milk Steamer", "Manual Coffee Grinder", "Pour-Over Kit", "French Press",
  "Cold Brew Pitcher", "Electric Kettle", "Tea Infuser Set", "Matcha Whisk",
];

export const CUSTOMER_NAMES: string[] = [
  "John", "Emily", "Sarah", "Michael", "David", "Ryan", "Olivia", "Emma", "Jacob",
  "Daniel", "Sophia", "James", "Lucas", "Alex", "Jennifer", "Ashley", "Jessica",
  "Christopher", "Ava", "Noah", "Mia", "Ethan", "Isabella", "Liam", "Chloe",
  "Mason", "Grace", "Henry", "Zoe", "Samuel", "Lily", "Jack", "Hannah", "Owen",
  "Ella", "Caleb", "Scarlett", "Nathan", "Aria", "Dylan",
];

export const PERSONAS: string[] = [
  "Budget-conscious parent",
  "Skeptical engineer",
  "Busy CEO",
  "Elderly retiree",
  "College student",
  "Impulsive shopper",
  "Luxury buyer",
  "Extremely impatient customer",
  "Friendly but cautious",
  "Loyal competitor customer",
  "Single parent in a rush",
  "Night-shift worker half asleep",
  "Small-business owner",
  "Teenager borrowing the phone",
  "Commuter stuck in traffic",
  "Landlord juggling repairs",
  "Fitness coach between clients",
  "Tech-averse senior",
  "New parent with a crying baby",
  "Overworked nurse on a break",
];

export const MOODS: string[] = [
  "you're busy making dinner",
  "you're driving",
  "you're watching TV",
  "you're in the middle of something",
  "you're waiting for food delivery",
  "you're half asleep",
  "you're taking care of kids",
  "you're at work",
  "you're walking outside",
  "you're annoyed by sales calls today",
  "you're in a good mood and a little chatty",
  "you're stressed about money",
];

// ─── No-frequent-repeat pickers ─────────────────────────────────────────

const recentProducts: string[] = [];
const recentNames: string[] = [];
const recentPersonas: string[] = [];
const recentMoods: string[] = [];

function pickNoRepeat<T>(arr: T[], recent: T[], windowSize: number): T {
  let pool = arr.filter((x) => !recent.includes(x));
  if (pool.length === 0) pool = arr;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  recent.push(pick);
  if (recent.length > windowSize) recent.shift();
  return pick;
}

export function pickProduct(): string {
  return pickNoRepeat(PRODUCTS, recentProducts, 5);
}

export function pickName(): string {
  return pickNoRepeat(CUSTOMER_NAMES, recentNames, 5);
}

export function pickPersona(): string {
  return pickNoRepeat(PERSONAS, recentPersonas, 4);
}

export function pickMood(): string {
  return pickNoRepeat(MOODS, recentMoods, 4);
}
